/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import React, { useEffect } from 'react';
import { BehaviorSubject } from 'rxjs';
import fastIsEqual from 'fast-deep-equal';
import { CoreStart } from '@kbn/core/public';
import { DataView } from '@kbn/data-views-plugin/common';
import { DataViewsPublicPluginStart } from '@kbn/data-views-plugin/public';
import { ReactEmbeddableFactory } from '@kbn/embeddable-plugin/public';
import { i18n } from '@kbn/i18n';
import {
  apiHasSaveNotification,
  combineCompatibleChildrenApis,
} from '@kbn/presentation-containers';
import {
  apiPublishesDataViews,
  PublishesDataViews,
  useBatchedPublishingSubjects,
} from '@kbn/presentation-publishing';
import { apiPublishesReload } from '@kbn/presentation-publishing/interfaces/fetch/publishes_reload';
import { ControlStyle, ParentIgnoreSettings } from '../..';
import {
  ControlGroupChainingSystem,
  CONTROL_GROUP_TYPE,
  DEFAULT_CONTROL_STYLE,
} from '../../../common';
import { chaining$, controlFetch$, controlGroupFetch$ } from './control_fetch';
import { initControlsManager } from './init_controls_manager';
import { openEditControlGroupFlyout } from './open_edit_control_group_flyout';
import { deserializeControlGroup } from './serialization_utils';
import { ControlGroupApi, ControlGroupRuntimeState, ControlGroupSerializedState } from './types';
import { ControlGroup } from './components/control_group';
import { initSelectionsManager } from './selections_manager';
import { initializeControlGroupUnsavedChanges } from './control_group_unsaved_changes_api';
import { openDataControlEditor } from '../controls/data_controls/open_data_control_editor';

export const getControlGroupEmbeddableFactory = (services: {
  core: CoreStart;
  dataViews: DataViewsPublicPluginStart;
}) => {
  const controlGroupEmbeddableFactory: ReactEmbeddableFactory<
    ControlGroupSerializedState,
    ControlGroupRuntimeState,
    ControlGroupApi
  > = {
    type: CONTROL_GROUP_TYPE,
    deserializeState: (state) => deserializeControlGroup(state),
    buildEmbeddable: async (
      initialRuntimeState,
      buildApi,
      uuid,
      parentApi,
      setApi,
      lastSavedRuntimeState
    ) => {
      const {
        initialChildControlState,
        labelPosition: initialLabelPosition,
        chainingSystem,
        autoApplySelections,
        ignoreParentSettings,
      } = initialRuntimeState;

      const autoApplySelections$ = new BehaviorSubject<boolean>(autoApplySelections);
      const parentDataViewId = apiPublishesDataViews(parentApi)
        ? parentApi.dataViews.value?.[0]?.id
        : undefined;
      const controlsManager = initControlsManager(
        initialChildControlState,
        parentDataViewId ?? (await services.dataViews.getDefaultId())
      );
      const selectionsManager = initSelectionsManager({
        ...controlsManager.api,
        autoApplySelections$,
      });
      const dataViews = new BehaviorSubject<DataView[] | undefined>(undefined);
      const chainingSystem$ = new BehaviorSubject<ControlGroupChainingSystem>(chainingSystem);
      const ignoreParentSettings$ = new BehaviorSubject<ParentIgnoreSettings | undefined>(
        ignoreParentSettings
      );
      const labelPosition$ = new BehaviorSubject<ControlStyle>( // TODO: Rename `ControlStyle`
        initialLabelPosition ?? DEFAULT_CONTROL_STYLE // TODO: Rename `DEFAULT_CONTROL_STYLE`
      );
      const allowExpensiveQueries$ = new BehaviorSubject<boolean>(true);

      /** TODO: Handle loading; loading should be true if any child is loading */
      const dataLoading$ = new BehaviorSubject<boolean | undefined>(false);

      const unsavedChanges = initializeControlGroupUnsavedChanges(
        selectionsManager.applySelections,
        controlsManager.api.children$,
        {
          ...controlsManager.comparators,
          autoApplySelections: [
            autoApplySelections$,
            (next: boolean) => autoApplySelections$.next(next),
          ],
          chainingSystem: [
            chainingSystem$,
            (next: ControlGroupChainingSystem) => chainingSystem$.next(next),
          ],
          ignoreParentSettings: [
            ignoreParentSettings$,
            (next: ParentIgnoreSettings | undefined) => ignoreParentSettings$.next(next),
            fastIsEqual,
          ],
          labelPosition: [labelPosition$, (next: ControlStyle) => labelPosition$.next(next)],
        },
        controlsManager.snapshotControlsRuntimeState,
        parentApi,
        lastSavedRuntimeState
      );

      const api = setApi({
        ...controlsManager.api,
        getLastSavedControlState: (controlUuid: string) => {
          return lastSavedRuntimeState.initialChildControlState[controlUuid] ?? {};
        },
        ...unsavedChanges.api,
        ...selectionsManager.api,
        controlFetch$: (controlUuid: string) =>
          controlFetch$(
            chaining$(
              controlUuid,
              chainingSystem$,
              controlsManager.controlsInOrder$,
              controlsManager.api.children$
            ),
            controlGroupFetch$(ignoreParentSettings$, parentApi ? parentApi : {})
          ),
        ignoreParentSettings$,
        autoApplySelections$,
        allowExpensiveQueries$,
        snapshotRuntimeState: () => {
          // TODO: Remove this if it ends up being unnecessary
          return {} as unknown as ControlGroupRuntimeState;
        },
        dataLoading: dataLoading$,
        onEdit: async () => {
          openEditControlGroupFlyout(
            api,
            {
              chainingSystem: chainingSystem$,
              labelPosition: labelPosition$,
              autoApplySelections: autoApplySelections$,
              ignoreParentSettings: ignoreParentSettings$,
            },
            { core: services.core }
          );
        },
        isEditingEnabled: () => true,
        getTypeDisplayName: () =>
          i18n.translate('controls.controlGroup.displayName', {
            defaultMessage: 'Controls',
          }),
        openAddDataControlFlyout: (settings) => {
          const { controlInputTransform } = settings ?? {
            controlInputTransform: (state) => state,
          };
          openDataControlEditor({
            initialState: controlsManager.getNewControlState(),
            onSave: ({ type: controlType, state: initialState }) => {
              controlsManager.api.addNewPanel({
                panelType: controlType,
                initialState: controlInputTransform!(
                  initialState as Partial<ControlGroupSerializedState>,
                  controlType
                ),
              });
            },
            controlGroupApi: api,
            services,
          });
        },
        serializeState: () => {
          const { panelsJSON, references } = controlsManager.serializeControls();
          return {
            rawState: {
              chainingSystem: chainingSystem$.getValue(),
              controlStyle: labelPosition$.getValue(), // Rename "labelPosition" to "controlStyle"
              showApplySelections: !autoApplySelections$.getValue(),
              ignoreParentSettingsJSON: JSON.stringify(ignoreParentSettings$.getValue()),
              panelsJSON,
            },
            references,
          };
        },
        dataViews,
        labelPosition: labelPosition$,
        saveNotification$: apiHasSaveNotification(parentApi)
          ? parentApi.saveNotification$
          : undefined,
        reload$: apiPublishesReload(parentApi) ? parentApi.reload$ : undefined,
      });

      /** Subscribe to all children's output data views, combine them, and output them */
      const childrenDataViewsSubscription = combineCompatibleChildrenApis<
        PublishesDataViews,
        DataView[]
      >(api, 'dataViews', apiPublishesDataViews, []).subscribe((newDataViews) =>
        dataViews.next(newDataViews)
      );

      /** Fetch the allowExpensiveQuries setting for the children to use if necessary */
      try {
        const { allowExpensiveQueries } = await services.core.http.get<{
          allowExpensiveQueries: boolean;
          // TODO: Rename this route as part of https://github.com/elastic/kibana/issues/174961
        }>('/internal/controls/optionsList/getExpensiveQueriesSetting', {
          version: '1',
        });
        if (!allowExpensiveQueries) {
          // only set if this returns false, since it defaults to true
          allowExpensiveQueries$.next(allowExpensiveQueries);
        }
      } catch {
        // do nothing - default to true on error (which it was initialized to)
      }

      return {
        api,
        Component: () => {
          const [hasUnappliedSelections, labelPosition] = useBatchedPublishingSubjects(
            selectionsManager.hasUnappliedSelections$,
            labelPosition$
          );

          useEffect(() => {
            return () => {
              selectionsManager.cleanup();
              childrenDataViewsSubscription.unsubscribe();
            };
          }, []);

          return (
            <ControlGroup
              applySelections={selectionsManager.applySelections}
              controlGroupApi={api}
              controlsManager={controlsManager}
              hasUnappliedSelections={hasUnappliedSelections}
              labelPosition={labelPosition}
            />
          );
        },
      };
    },
  };

  return controlGroupEmbeddableFactory;
};
