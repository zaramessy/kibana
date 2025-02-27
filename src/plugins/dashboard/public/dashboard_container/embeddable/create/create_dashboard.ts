/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import {
  ControlGroupInput,
  CONTROL_GROUP_TYPE,
  getDefaultControlGroupInput,
  getDefaultControlGroupPersistableInput,
} from '@kbn/controls-plugin/common';
import {
  ControlGroupContainerFactory,
  ControlGroupOutput,
  type ControlGroupContainer,
} from '@kbn/controls-plugin/public';
import { GlobalQueryStateFromUrl, syncGlobalQueryStateWithUrl } from '@kbn/data-plugin/public';
import { EmbeddableFactory, isErrorEmbeddable, ViewMode } from '@kbn/embeddable-plugin/public';
import {
  AggregateQuery,
  compareFilters,
  COMPARE_ALL_OPTIONS,
  Filter,
  Query,
  TimeRange,
} from '@kbn/es-query';
import { lazyLoadReduxToolsPackage } from '@kbn/presentation-util-plugin/public';
import deepEqual from 'fast-deep-equal';
import { cloneDeep, identity, omit, pickBy } from 'lodash';
import {
  BehaviorSubject,
  combineLatest,
  distinctUntilChanged,
  map,
  startWith,
  Subject,
} from 'rxjs';
import { v4 } from 'uuid';
import {
  DashboardContainerInput,
  DashboardPanelMap,
  DashboardPanelState,
} from '../../../../common';
import {
  DEFAULT_DASHBOARD_INPUT,
  DEFAULT_PANEL_HEIGHT,
  DEFAULT_PANEL_WIDTH,
  GLOBAL_STATE_STORAGE_KEY,
  PanelPlacementStrategy,
} from '../../../dashboard_constants';
import {
  LoadDashboardReturn,
  SavedDashboardInput,
} from '../../../services/dashboard_content_management/types';
import { pluginServices } from '../../../services/plugin_services';
import { runPanelPlacementStrategy } from '../../panel_placement/place_new_panel_strategies';
import { startDiffingDashboardState } from '../../state/diffing/dashboard_diffing_integration';
import { DashboardPublicState, UnsavedPanelState } from '../../types';
import { DashboardContainer } from '../dashboard_container';
import { DashboardCreationOptions } from '../dashboard_container_factory';
import {
  combineDashboardFiltersWithControlGroupFilters,
  startSyncingDashboardControlGroup,
} from './controls/dashboard_control_group_integration';
import { startSyncingDashboardDataViews } from './data_views/sync_dashboard_data_views';
import { startQueryPerformanceTracking } from './performance/query_performance_tracking';
import { startDashboardSearchSessionIntegration } from './search_sessions/start_dashboard_search_session_integration';
import { syncUnifiedSearchState } from './unified_search/sync_dashboard_unified_search_state';

/**
 * Builds a new Dashboard from scratch.
 */
export const createDashboard = async (
  creationOptions?: DashboardCreationOptions,
  dashboardCreationStartTime?: number,
  savedObjectId?: string
): Promise<DashboardContainer | undefined> => {
  const {
    data: { dataViews },
    dashboardContentManagement: { loadDashboardState },
  } = pluginServices.getServices();

  // --------------------------------------------------------------------------------------
  // Create method which allows work to be done on the dashboard container when it's ready.
  // --------------------------------------------------------------------------------------
  const dashboardContainerReady$ = new Subject<DashboardContainer>();
  const untilDashboardReady = () =>
    new Promise<DashboardContainer>((resolve) => {
      const subscription = dashboardContainerReady$.subscribe((container) => {
        subscription.unsubscribe();
        resolve(container);
      });
    });

  // --------------------------------------------------------------------------------------
  // Lazy load required systems and Dashboard saved object.
  // --------------------------------------------------------------------------------------
  const reduxEmbeddablePackagePromise = lazyLoadReduxToolsPackage();
  const defaultDataViewExistsPromise = dataViews.defaultDataViewExists();
  const dashboardSavedObjectPromise = loadDashboardState({ id: savedObjectId });

  const [reduxEmbeddablePackage, savedObjectResult] = await Promise.all([
    reduxEmbeddablePackagePromise,
    dashboardSavedObjectPromise,
    defaultDataViewExistsPromise /* the result is not used, but the side effect of setting the default data view is needed. */,
  ]);

  // --------------------------------------------------------------------------------------
  // Initialize Dashboard integrations
  // --------------------------------------------------------------------------------------
  const initializeResult = await initializeDashboard({
    loadDashboardReturn: savedObjectResult,
    untilDashboardReady,
    creationOptions,
  });
  if (!initializeResult) return;
  const { input, searchSessionId } = initializeResult;

  // --------------------------------------------------------------------------------------
  // Build the dashboard container.
  // --------------------------------------------------------------------------------------
  const initialComponentState: DashboardPublicState = {
    lastSavedInput: omit(savedObjectResult?.dashboardInput, 'controlGroupInput') ?? {
      ...DEFAULT_DASHBOARD_INPUT,
      id: input.id,
    },
    hasRunClientsideMigrations: savedObjectResult.anyMigrationRun,
    isEmbeddedExternally: creationOptions?.isEmbeddedExternally,
    animatePanelTransforms: false, // set panel transforms to false initially to avoid panels animating on initial render.
    hasUnsavedChanges: false, // if there is initial unsaved changes, the initial diff will catch them.
    managed: savedObjectResult.managed,
    lastSavedId: savedObjectId,
  };

  const dashboardContainer = new DashboardContainer(
    input,
    reduxEmbeddablePackage,
    searchSessionId,
    dashboardCreationStartTime,
    undefined,
    creationOptions,
    initialComponentState
  );

  // --------------------------------------------------------------------------------------
  // Start the diffing integration after all other integrations are set up.
  // --------------------------------------------------------------------------------------
  untilDashboardReady().then((container) => {
    startDiffingDashboardState.bind(container)(creationOptions);
  });

  dashboardContainerReady$.next(dashboardContainer);
  return dashboardContainer;
};

/**
 * Initializes a Dashboard and starts all of its integrations
 */
export const initializeDashboard = async ({
  loadDashboardReturn,
  untilDashboardReady,
  creationOptions,
  controlGroup,
}: {
  loadDashboardReturn: LoadDashboardReturn;
  untilDashboardReady: () => Promise<DashboardContainer>;
  creationOptions?: DashboardCreationOptions;
  controlGroup?: ControlGroupContainer;
}) => {
  const {
    dashboardBackup,
    embeddable: { getEmbeddableFactory },
    dashboardCapabilities: { showWriteControls },
    embeddable: { reactEmbeddableRegistryHasKey },
    data: {
      query: queryService,
      search: { session },
    },
    dashboardContentInsights,
  } = pluginServices.getServices();
  const {
    queryString,
    filterManager,
    timefilter: { timefilter: timefilterService },
  } = queryService;

  const {
    getInitialInput,
    searchSessionSettings,
    unifiedSearchSettings,
    validateLoadedSavedObject,
    useControlGroupIntegration,
    useUnifiedSearchIntegration,
    useSessionStorageIntegration,
  } = creationOptions ?? {};

  // --------------------------------------------------------------------------------------
  // Run validation.
  // --------------------------------------------------------------------------------------
  const validationResult = loadDashboardReturn && validateLoadedSavedObject?.(loadDashboardReturn);
  if (validationResult === 'invalid') {
    // throw error to stop the rest of Dashboard loading and make the factory return an ErrorEmbeddable.
    throw new Error('Dashboard failed saved object result validation');
  } else if (validationResult === 'redirected') {
    return;
  }

  // --------------------------------------------------------------------------------------
  // Combine input from saved object, and session storage
  // --------------------------------------------------------------------------------------
  const dashboardBackupState = dashboardBackup.getState(loadDashboardReturn.dashboardId);
  const runtimePanelsToRestore: UnsavedPanelState = useSessionStorageIntegration
    ? dashboardBackupState?.panels ?? {}
    : {};

  const sessionStorageInput = ((): Partial<SavedDashboardInput> | undefined => {
    if (!useSessionStorageIntegration) return;
    return dashboardBackupState?.dashboardState;
  })();
  const initialViewMode = (() => {
    if (loadDashboardReturn.managed || !showWriteControls) return ViewMode.VIEW;
    if (
      loadDashboardReturn.newDashboardCreated ||
      dashboardBackup.dashboardHasUnsavedEdits(loadDashboardReturn.dashboardId)
    ) {
      return ViewMode.EDIT;
    }

    return dashboardBackup.getViewMode();
  })();

  const combinedSessionInput: DashboardContainerInput = {
    ...DEFAULT_DASHBOARD_INPUT,
    ...(loadDashboardReturn?.dashboardInput ?? {}),
    ...sessionStorageInput,
  };

  // --------------------------------------------------------------------------------------
  // Combine input with overrides.
  // --------------------------------------------------------------------------------------
  const overrideInput = getInitialInput?.();
  if (overrideInput?.panels) {
    /**
     * react embeddables and legacy embeddables share state very differently, so we need different
     * treatment here. TODO remove this distinction when we remove the legacy embeddable system.
     */
    const overridePanels: DashboardPanelMap = {};

    for (const panel of Object.values(overrideInput?.panels)) {
      if (reactEmbeddableRegistryHasKey(panel.type)) {
        overridePanels[panel.explicitInput.id] = {
          ...panel,

          /**
           * here we need to keep the state of the panel that was already in the Dashboard if one exists.
           * This is because this state will become the "last saved state" for this panel.
           */
          ...(combinedSessionInput.panels[panel.explicitInput.id] ?? []),
        };
        /**
         * We also need to add the state of this react embeddable into the runtime state to be restored.
         */
        runtimePanelsToRestore[panel.explicitInput.id] = panel.explicitInput;
      } else {
        /**
         * if this is a legacy embeddable, the override state needs to completely overwrite the existing
         * state for this panel.
         */
        overridePanels[panel.explicitInput.id] = panel;
      }
    }

    /**
     * If this is a React embeddable, we leave the "panel" state as-is and add this state to the
     * runtime state to be restored on dashboard load.
     */
    overrideInput.panels = overridePanels;
  }
  const combinedOverrideInput: DashboardContainerInput = {
    ...combinedSessionInput,
    ...(initialViewMode ? { viewMode: initialViewMode } : {}),
    ...overrideInput,
  };

  // --------------------------------------------------------------------------------------
  // Combine input from saved object, session storage, & passed input to create initial input.
  // --------------------------------------------------------------------------------------
  const initialDashboardInput: DashboardContainerInput = omit(
    cloneDeep(combinedOverrideInput),
    'controlGroupInput'
  );
  const initialControlGroupInput: ControlGroupInput | {} = {
    ...(loadDashboardReturn?.dashboardInput?.controlGroupInput ?? {}),
    ...(sessionStorageInput?.controlGroupInput ?? {}),
    ...(overrideInput?.controlGroupInput ?? {}),
  };

  // Back up any view mode passed in explicitly.
  if (overrideInput?.viewMode) {
    dashboardBackup.storeViewMode(overrideInput?.viewMode);
  }

  initialDashboardInput.executionContext = {
    type: 'dashboard',
    description: initialDashboardInput.title,
  };

  // --------------------------------------------------------------------------------------
  // Track references
  // --------------------------------------------------------------------------------------
  untilDashboardReady().then((dashboard) => {
    dashboard.savedObjectReferences = loadDashboardReturn?.references;
  });

  // --------------------------------------------------------------------------------------
  // Set up unified search integration.
  // --------------------------------------------------------------------------------------
  if (useUnifiedSearchIntegration && unifiedSearchSettings?.kbnUrlStateStorage) {
    const {
      query,
      filters,
      timeRestore,
      timeRange: savedTimeRange,
      refreshInterval: savedRefreshInterval,
    } = initialDashboardInput;
    const { kbnUrlStateStorage } = unifiedSearchSettings;

    // apply filters and query to the query service
    filterManager.setAppFilters(cloneDeep(filters ?? []));
    queryString.setQuery(query ?? queryString.getDefaultQuery());

    /**
     * Get initial time range, and set up dashboard time restore if applicable
     */
    const initialTimeRange: TimeRange = (() => {
      // if there is an explicit time range in the URL it always takes precedence.
      const urlOverrideTimeRange =
        kbnUrlStateStorage.get<GlobalQueryStateFromUrl>(GLOBAL_STATE_STORAGE_KEY)?.time;
      if (urlOverrideTimeRange) return urlOverrideTimeRange;

      // if this Dashboard has timeRestore return the time range that was saved with the dashboard.
      if (timeRestore && savedTimeRange) return savedTimeRange;

      // otherwise fall back to the time range from the timefilterService.
      return timefilterService.getTime();
    })();
    initialDashboardInput.timeRange = initialTimeRange;
    if (timeRestore) {
      if (savedTimeRange) timefilterService.setTime(savedTimeRange);
      if (savedRefreshInterval) timefilterService.setRefreshInterval(savedRefreshInterval);
    }

    // start syncing global query state with the URL.
    const { stop: stopSyncingQueryServiceStateWithUrl } = syncGlobalQueryStateWithUrl(
      queryService,
      kbnUrlStateStorage
    );

    untilDashboardReady().then((dashboardContainer) => {
      const stopSyncingUnifiedSearchState =
        syncUnifiedSearchState.bind(dashboardContainer)(kbnUrlStateStorage);
      dashboardContainer.stopSyncingWithUnifiedSearch = () => {
        stopSyncingUnifiedSearchState();
        stopSyncingQueryServiceStateWithUrl();
      };
    });
  }

  // --------------------------------------------------------------------------------------
  // Place the incoming embeddable if there is one
  // --------------------------------------------------------------------------------------
  const incomingEmbeddable = creationOptions?.getIncomingEmbeddable?.();
  if (incomingEmbeddable) {
    const scrolltoIncomingEmbeddable = (container: DashboardContainer, id: string) => {
      container.setScrollToPanelId(id);
      container.setHighlightPanelId(id);
    };

    initialDashboardInput.viewMode = ViewMode.EDIT; // view mode must always be edit to recieve an embeddable.
    if (
      incomingEmbeddable.embeddableId &&
      Boolean(initialDashboardInput.panels[incomingEmbeddable.embeddableId])
    ) {
      // this embeddable already exists, we will update the explicit input.
      const panelToUpdate = initialDashboardInput.panels[incomingEmbeddable.embeddableId];
      const sameType = panelToUpdate.type === incomingEmbeddable.type;

      panelToUpdate.type = incomingEmbeddable.type;
      const nextRuntimeState = {
        // if the incoming panel is the same type as what was there before we can safely spread the old panel's explicit input
        ...(sameType ? panelToUpdate.explicitInput : {}),

        ...incomingEmbeddable.input,
        id: incomingEmbeddable.embeddableId,

        // maintain hide panel titles setting.
        hidePanelTitles: panelToUpdate.explicitInput.hidePanelTitles,
      };
      if (reactEmbeddableRegistryHasKey(incomingEmbeddable.type)) {
        panelToUpdate.explicitInput = { id: panelToUpdate.explicitInput.id };
        runtimePanelsToRestore[incomingEmbeddable.embeddableId] = nextRuntimeState;
      } else {
        panelToUpdate.explicitInput = nextRuntimeState;
      }

      untilDashboardReady().then((container) =>
        scrolltoIncomingEmbeddable(container, incomingEmbeddable.embeddableId as string)
      );
    } else {
      // otherwise this incoming embeddable is brand new and can be added after the dashboard container is created.

      untilDashboardReady().then(async (container) => {
        const createdEmbeddable = await (async () => {
          // if there is no width or height we can add the panel using the default behaviour.
          if (!incomingEmbeddable.size) {
            return await container.addNewPanel<{ uuid: string }>({
              panelType: incomingEmbeddable.type,
              initialState: incomingEmbeddable.input,
            });
          }

          // if the incoming embeddable has an explicit width or height we add the panel to the grid directly.
          const { width, height } = incomingEmbeddable.size;
          const currentPanels = container.getInput().panels;
          const embeddableId = incomingEmbeddable.embeddableId ?? v4();
          const { newPanelPlacement } = runPanelPlacementStrategy(
            PanelPlacementStrategy.findTopLeftMostOpenSpace,
            {
              width: width ?? DEFAULT_PANEL_WIDTH,
              height: height ?? DEFAULT_PANEL_HEIGHT,
              currentPanels,
            }
          );
          const newPanelState: DashboardPanelState = (() => {
            if (reactEmbeddableRegistryHasKey(incomingEmbeddable.type)) {
              runtimePanelsToRestore[embeddableId] = incomingEmbeddable.input;
              return {
                explicitInput: { id: embeddableId },
                type: incomingEmbeddable.type,
                gridData: {
                  ...newPanelPlacement,
                  i: embeddableId,
                },
              };
            }
            return {
              explicitInput: { ...incomingEmbeddable.input, id: embeddableId },
              type: incomingEmbeddable.type,
              gridData: {
                ...newPanelPlacement,
                i: embeddableId,
              },
            };
          })();
          container.updateInput({
            panels: {
              ...container.getInput().panels,
              [newPanelState.explicitInput.id]: newPanelState,
            },
          });

          return await container.untilEmbeddableLoaded(embeddableId);
        })();
        if (createdEmbeddable) {
          scrolltoIncomingEmbeddable(container, createdEmbeddable.uuid);
        }
      });
    }
  }

  // --------------------------------------------------------------------------------------
  // Set restored runtime state for react embeddables.
  // --------------------------------------------------------------------------------------
  untilDashboardReady().then((dashboardContainer) => {
    for (const idWithRuntimeState of Object.keys(runtimePanelsToRestore)) {
      const restoredRuntimeStateForChild = runtimePanelsToRestore[idWithRuntimeState];
      if (!restoredRuntimeStateForChild) continue;
      dashboardContainer.setRuntimeStateForChild(idWithRuntimeState, restoredRuntimeStateForChild);
    }
  });

  // --------------------------------------------------------------------------------------
  // Start the control group integration.
  // --------------------------------------------------------------------------------------
  if (useControlGroupIntegration) {
    const controlsGroupFactory = getEmbeddableFactory<
      ControlGroupInput,
      ControlGroupOutput,
      ControlGroupContainer
    >(CONTROL_GROUP_TYPE) as EmbeddableFactory<
      ControlGroupInput,
      ControlGroupOutput,
      ControlGroupContainer
    > & {
      create: ControlGroupContainerFactory['create'];
    };
    const { filters, query, timeRange, viewMode, id } = initialDashboardInput;
    const fullControlGroupInput = {
      id: `control_group_${id ?? 'new_dashboard'}`,
      ...getDefaultControlGroupInput(),
      ...pickBy(initialControlGroupInput, identity), // undefined keys in initialInput should not overwrite defaults
      timeRange,
      viewMode,
      filters,
      query,
    };

    if (controlGroup) {
      controlGroup.updateInputAndReinitialize(fullControlGroupInput);
    } else {
      const newControlGroup = await controlsGroupFactory?.create(fullControlGroupInput, this, {
        lastSavedInput:
          loadDashboardReturn?.dashboardInput?.controlGroupInput ??
          getDefaultControlGroupPersistableInput(),
      });
      if (!newControlGroup || isErrorEmbeddable(newControlGroup)) {
        throw new Error('Error in control group startup');
      }
      controlGroup = newControlGroup;
    }

    untilDashboardReady().then((dashboardContainer) => {
      dashboardContainer.controlGroup = controlGroup;
      startSyncingDashboardControlGroup.bind(dashboardContainer)();
    });
  }

  // --------------------------------------------------------------------------------------
  // Start the data views integration.
  // --------------------------------------------------------------------------------------
  untilDashboardReady().then((dashboardContainer) => {
    dashboardContainer.integrationSubscriptions.add(
      startSyncingDashboardDataViews.bind(dashboardContainer)()
    );
  });

  // --------------------------------------------------------------------------------------
  // Start performance tracker
  // --------------------------------------------------------------------------------------
  untilDashboardReady().then((dashboardContainer) =>
    dashboardContainer.integrationSubscriptions.add(
      startQueryPerformanceTracking(dashboardContainer)
    )
  );

  // --------------------------------------------------------------------------------------
  // Start animating panel transforms 500 ms after dashboard is created.
  // --------------------------------------------------------------------------------------
  untilDashboardReady().then((dashboard) =>
    setTimeout(() => dashboard.dispatch.setAnimatePanelTransforms(true), 500)
  );

  // --------------------------------------------------------------------------------------
  // Set parentApi.filters$ to include dashboardContainer filters and control group filters
  // --------------------------------------------------------------------------------------
  untilDashboardReady().then((dashboardContainer) => {
    if (!dashboardContainer.controlGroup) {
      return;
    }

    function getCombinedFilters() {
      return combineDashboardFiltersWithControlGroupFilters(
        dashboardContainer.getInput().filters ?? [],
        dashboardContainer.controlGroup!
      );
    }

    const filters$ = new BehaviorSubject<Filter[] | undefined>(getCombinedFilters());
    dashboardContainer.filters$ = filters$;

    const inputFilters$ = dashboardContainer.getInput$().pipe(
      startWith(dashboardContainer.getInput()),
      map((input) => input.filters),
      distinctUntilChanged((previous, current) => {
        return compareFilters(previous ?? [], current ?? [], COMPARE_ALL_OPTIONS);
      })
    );

    // Can not use onFiltersPublished$ directly since it does not have an intial value and
    // combineLatest will not emit until each observable emits at least one value
    const controlGroupFilters$ = dashboardContainer.controlGroup.onFiltersPublished$.pipe(
      startWith(dashboardContainer.controlGroup.getOutput().filters)
    );

    dashboardContainer.integrationSubscriptions.add(
      combineLatest([inputFilters$, controlGroupFilters$]).subscribe(() => {
        filters$.next(getCombinedFilters());
      })
    );
  });

  // --------------------------------------------------------------------------------------
  // Set up parentApi.query$
  // Can not use legacyEmbeddableToApi since query$ setting is delayed
  // --------------------------------------------------------------------------------------
  untilDashboardReady().then((dashboardContainer) => {
    const query$ = new BehaviorSubject<Query | AggregateQuery | undefined>(
      dashboardContainer.getInput().query
    );
    dashboardContainer.query$ = query$;
    dashboardContainer.integrationSubscriptions.add(
      dashboardContainer.getInput$().subscribe((input) => {
        if (!deepEqual(query$.getValue() ?? [], input.query)) {
          query$.next(input.query);
        }
      })
    );
  });

  // --------------------------------------------------------------------------------------
  // Set up search sessions integration.
  // --------------------------------------------------------------------------------------
  let initialSearchSessionId;
  if (searchSessionSettings) {
    const { sessionIdToRestore } = searchSessionSettings;

    // if this incoming embeddable has a session, continue it.
    if (incomingEmbeddable?.searchSessionId) {
      session.continue(incomingEmbeddable.searchSessionId);
    }
    if (sessionIdToRestore) {
      session.restore(sessionIdToRestore);
    }
    const existingSession = session.getSessionId();

    initialSearchSessionId =
      sessionIdToRestore ??
      (existingSession && incomingEmbeddable ? existingSession : session.start());

    untilDashboardReady().then((container) => {
      startDashboardSearchSessionIntegration.bind(container)(
        creationOptions?.searchSessionSettings
      );
    });
  }

  if (loadDashboardReturn.dashboardId && !incomingEmbeddable) {
    // We count a new view every time a user opens a dashboard, both in view or edit mode
    // We don't count views when a user is editing a dashboard and is returning from an editor after saving
    // however, there is an edge case that we now count a new view when a user is editing a dashboard and is returning from an editor by canceling
    // TODO: this should be revisited by making embeddable transfer support canceling logic https://github.com/elastic/kibana/issues/190485
    dashboardContentInsights.trackDashboardView(loadDashboardReturn.dashboardId);
  }

  return { input: initialDashboardInput, searchSessionId: initialSearchSessionId };
};
