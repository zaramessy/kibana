/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import './table.scss';
import React, { useCallback, useMemo, useState } from 'react';
import useWindowSize from 'react-use/lib/useWindowSize';
import useLocalStorage from 'react-use/lib/useLocalStorage';
import {
  EuiFlexGroup,
  EuiFlexItem,
  EuiSpacer,
  EuiSelectableMessage,
  EuiDataGrid,
  EuiDataGridProps,
  EuiDataGridCellPopoverElementProps,
  EuiI18n,
  EuiText,
  EuiCallOut,
  useResizeObserver,
  EuiSwitch,
  useEuiTheme,
  EuiSwitchEvent,
} from '@elastic/eui';
import { i18n } from '@kbn/i18n';
import { css } from '@emotion/react';
import { Storage } from '@kbn/kibana-utils-plugin/public';
import { getFieldIconType } from '@kbn/field-utils/src/utils/get_field_icon_type';
import {
  SHOW_MULTIFIELDS,
  formatFieldValue,
  getIgnoredReason,
  getShouldShowFieldHandler,
  isNestedFieldParent,
  usePager,
} from '@kbn/discover-utils';
import { getTextBasedColumnIconType } from '@kbn/field-utils';
import type { DocViewRenderProps } from '@kbn/unified-doc-viewer/types';
import { getUnifiedDocViewerServices } from '../../plugin';
import {
  type TableRow,
  getFieldCellActions,
  getFieldValueCellActions,
  getFilterExistsDisabledWarning,
  getFilterInOutPairDisabledWarning,
} from './table_cell_actions';
import {
  DEFAULT_MARGIN_BOTTOM,
  getTabContentAvailableHeight,
} from '../doc_viewer_source/get_height';
import { TableFilters, TableFiltersProps, useTableFilters } from './table_filters';
import { TableCell } from './table_cell';
import { getPinColumnControl } from './get_pin_control';

export type FieldRecord = TableRow;

interface ItemsEntry {
  pinnedItems: FieldRecord[];
  restItems: FieldRecord[];
  allFields: TableFiltersProps['allFields'];
}

const MIN_NAME_COLUMN_WIDTH = 150;
const MAX_NAME_COLUMN_WIDTH = 350;
const PAGE_SIZE_OPTIONS = [25, 50, 100, 250, 500];
const DEFAULT_PAGE_SIZE = 25;
const PINNED_FIELDS_KEY = 'discover:pinnedFields';
const PAGE_SIZE = 'discover:pageSize';
const HIDE_NULL_VALUES = 'unifiedDocViewer:hideNullValues';

const GRID_COLUMN_FIELD_NAME = 'name';
const GRID_COLUMN_FIELD_VALUE = 'value';

const GRID_PROPS: Pick<EuiDataGridProps, 'columnVisibility' | 'rowHeightsOptions' | 'gridStyle'> = {
  columnVisibility: {
    visibleColumns: ['name', 'value'],
    setVisibleColumns: () => null,
  },
  rowHeightsOptions: { defaultHeight: 'auto' },
  gridStyle: {
    border: 'horizontal',
    stripes: true,
    rowHover: 'highlight',
    header: 'underline',
    cellPadding: 'm',
    fontSize: 's',
  },
};

const getPinnedFields = (dataViewId: string, storage: Storage): string[] => {
  const pinnedFieldsEntry = storage.get(PINNED_FIELDS_KEY);
  if (
    typeof pinnedFieldsEntry === 'object' &&
    pinnedFieldsEntry !== null &&
    Array.isArray(pinnedFieldsEntry[dataViewId])
  ) {
    return pinnedFieldsEntry[dataViewId].filter((cur: unknown) => typeof cur === 'string');
  }
  return [];
};
const updatePinnedFieldsState = (newFields: string[], dataViewId: string, storage: Storage) => {
  let pinnedFieldsEntry = storage.get(PINNED_FIELDS_KEY);
  pinnedFieldsEntry =
    typeof pinnedFieldsEntry === 'object' && pinnedFieldsEntry !== null ? pinnedFieldsEntry : {};

  storage.set(PINNED_FIELDS_KEY, {
    ...pinnedFieldsEntry,
    [dataViewId]: newFields,
  });
};

const getPageSize = (storage: Storage): number => {
  const pageSize = Number(storage.get(PAGE_SIZE));
  return pageSize && PAGE_SIZE_OPTIONS.includes(pageSize) ? pageSize : DEFAULT_PAGE_SIZE;
};
const updatePageSize = (newPageSize: number, storage: Storage) => {
  storage.set(PAGE_SIZE, newPageSize);
};

export const DocViewerTable = ({
  columns,
  columnsMeta,
  hit,
  dataView,
  textBasedHits,
  filter,
  decreaseAvailableHeightBy,
  onAddColumn,
  onRemoveColumn,
}: DocViewRenderProps) => {
  const isEsqlMode = Array.isArray(textBasedHits);
  const [containerRef, setContainerRef] = useState<HTMLDivElement | null>(null);
  const { fieldFormats, storage, uiSettings } = getUnifiedDocViewerServices();
  const showMultiFields = uiSettings.get(SHOW_MULTIFIELDS);
  const currentDataViewId = dataView.id!;

  const [pinnedFields, setPinnedFields] = useState<string[]>(
    getPinnedFields(currentDataViewId, storage)
  );
  const [areNullValuesHidden, setAreNullValuesHidden] = useLocalStorage(HIDE_NULL_VALUES, false);

  const { euiTheme } = useEuiTheme();

  const flattened = hit.flattened;
  const shouldShowFieldHandler = useMemo(
    () => getShouldShowFieldHandler(Object.keys(flattened), dataView, showMultiFields),
    [flattened, dataView, showMultiFields]
  );

  const mapping = useCallback((name: string) => dataView.fields.getByName(name), [dataView.fields]);

  const onToggleColumn = useMemo(() => {
    if (!onRemoveColumn || !onAddColumn || !columns) {
      return undefined;
    }
    return (field: string) => {
      if (columns.includes(field)) {
        onRemoveColumn(field);
      } else {
        onAddColumn(field);
      }
    };
  }, [onRemoveColumn, onAddColumn, columns]);

  const onTogglePinned = useCallback(
    (field: string) => {
      const newPinned = pinnedFields.includes(field)
        ? pinnedFields.filter((curField) => curField !== field)
        : [...pinnedFields, field];

      updatePinnedFieldsState(newPinned, currentDataViewId, storage);
      setPinnedFields(newPinned);
    },
    [currentDataViewId, pinnedFields, storage]
  );

  const { onFilterField, ...tableFiltersProps } = useTableFilters(storage);

  const fieldToItem = useCallback(
    (field: string, isPinned: boolean) => {
      const fieldMapping = mapping(field);
      const displayName = fieldMapping?.displayName ?? field;
      const columnMeta = columnsMeta?.[field];
      const columnIconType = getTextBasedColumnIconType(columnMeta);
      const fieldType = columnIconType
        ? columnIconType // for text-based results types come separately
        : isNestedFieldParent(field, dataView)
        ? 'nested'
        : fieldMapping
        ? getFieldIconType(fieldMapping)
        : undefined;

      const ignored = getIgnoredReason(fieldMapping ?? field, hit.raw._ignored);

      return {
        action: {
          onToggleColumn,
          onFilter: filter,
          flattenedField: flattened[field],
        },
        field: {
          field,
          displayName,
          fieldMapping,
          fieldType,
          scripted: Boolean(fieldMapping?.scripted),
          pinned: isPinned,
          onTogglePinned,
        },
        value: {
          formattedValue: formatFieldValue(
            hit.flattened[field],
            hit.raw,
            fieldFormats,
            dataView,
            fieldMapping
          ),
          ignored,
        },
      };
    },
    [
      mapping,
      dataView,
      hit,
      onToggleColumn,
      filter,
      columnsMeta,
      flattened,
      onTogglePinned,
      fieldFormats,
    ]
  );

  const { pinnedItems, restItems, allFields } = useMemo(
    () =>
      Object.keys(flattened)
        .sort((fieldA, fieldB) => {
          const mappingA = mapping(fieldA);
          const mappingB = mapping(fieldB);
          const nameA = !mappingA || !mappingA.displayName ? fieldA : mappingA.displayName;
          const nameB = !mappingB || !mappingB.displayName ? fieldB : mappingB.displayName;
          return nameA.localeCompare(nameB);
        })
        .reduce<ItemsEntry>(
          (acc, curFieldName) => {
            if (!shouldShowFieldHandler(curFieldName)) {
              return acc;
            }
            const shouldHideNullValue =
              areNullValuesHidden && flattened[curFieldName] == null && isEsqlMode;
            if (shouldHideNullValue) {
              return acc;
            }

            const isPinned = pinnedFields.includes(curFieldName);
            const row = fieldToItem(curFieldName, isPinned);

            if (isPinned) {
              acc.pinnedItems.push(row);
            } else {
              if (onFilterField(curFieldName, row.field.displayName, row.field.fieldType)) {
                // filter only unpinned fields
                acc.restItems.push(row);
              }
            }

            acc.allFields.push({
              name: curFieldName,
              displayName: row.field.displayName,
              type: row.field.fieldType,
            });

            return acc;
          },
          {
            pinnedItems: [],
            restItems: [],
            allFields: [],
          }
        ),
    [
      areNullValuesHidden,
      fieldToItem,
      flattened,
      isEsqlMode,
      mapping,
      onFilterField,
      pinnedFields,
      shouldShowFieldHandler,
    ]
  );

  const rows = useMemo(() => [...pinnedItems, ...restItems], [pinnedItems, restItems]);

  const leadingControlColumns = useMemo(() => {
    return [getPinColumnControl({ rows })];
  }, [rows]);

  const { curPageIndex, pageSize, totalPages, changePageIndex, changePageSize } = usePager({
    initialPageSize: getPageSize(storage),
    totalItems: rows.length,
  });
  const showPagination = totalPages !== 0;

  const onChangePageSize = useCallback(
    (newPageSize: number) => {
      updatePageSize(newPageSize, storage);
      changePageSize(newPageSize);
    },
    [changePageSize, storage]
  );

  const pagination = useMemo(() => {
    return showPagination
      ? {
          onChangeItemsPerPage: onChangePageSize,
          onChangePage: changePageIndex,
          pageIndex: curPageIndex,
          pageSize,
          pageSizeOptions: PAGE_SIZE_OPTIONS,
        }
      : undefined;
  }, [showPagination, curPageIndex, pageSize, onChangePageSize, changePageIndex]);

  const fieldCellActions = useMemo(
    () => getFieldCellActions({ rows, filter, onToggleColumn }),
    [rows, filter, onToggleColumn]
  );
  const fieldValueCellActions = useMemo(
    () => getFieldValueCellActions({ rows, filter }),
    [rows, filter]
  );

  useWindowSize(); // trigger re-render on window resize to recalculate the grid container height
  const { width: containerWidth } = useResizeObserver(containerRef);

  const gridColumns: EuiDataGridProps['columns'] = useMemo(
    () => [
      {
        id: GRID_COLUMN_FIELD_NAME,
        displayAsText: i18n.translate('unifiedDocViewer.fieldChooser.discoverField.name', {
          defaultMessage: 'Field',
        }),
        initialWidth: Math.min(
          Math.max(Math.round(containerWidth * 0.3), MIN_NAME_COLUMN_WIDTH),
          MAX_NAME_COLUMN_WIDTH
        ),
        actions: false,
        visibleCellActions: 3,
        cellActions: fieldCellActions,
      },
      {
        id: GRID_COLUMN_FIELD_VALUE,
        displayAsText: i18n.translate('unifiedDocViewer.fieldChooser.discoverField.value', {
          defaultMessage: 'Value',
        }),
        actions: false,
        visibleCellActions: 2,
        cellActions: fieldValueCellActions,
      },
    ],
    [fieldCellActions, fieldValueCellActions, containerWidth]
  );

  const onHideNullValuesChange = useCallback(
    (e: EuiSwitchEvent) => {
      setAreNullValuesHidden(e.target.checked);
    },
    [setAreNullValuesHidden]
  );

  const renderCellValue: EuiDataGridProps['renderCellValue'] = useCallback(
    ({ rowIndex, columnId, isDetails }) => {
      return (
        <TableCell
          searchTerm={tableFiltersProps.searchTerm}
          rows={rows}
          rowIndex={rowIndex}
          columnId={columnId}
          isDetails={isDetails}
        />
      );
    },
    [rows, tableFiltersProps.searchTerm]
  );

  const renderCellPopover = useCallback(
    (props: EuiDataGridCellPopoverElementProps) => {
      const { columnId, children, cellActions, rowIndex } = props;
      const row = rows[rowIndex];

      let warningMessage: string | undefined;
      if (columnId === GRID_COLUMN_FIELD_VALUE) {
        warningMessage = getFilterInOutPairDisabledWarning(row);
      } else if (columnId === GRID_COLUMN_FIELD_NAME) {
        warningMessage = getFilterExistsDisabledWarning(row);
      }

      return (
        <>
          <EuiText size="s">{children}</EuiText>
          {cellActions}
          {Boolean(warningMessage) && (
            <div>
              <EuiSpacer size="xs" />
              <EuiCallOut title={warningMessage} color="warning" size="s" />
            </div>
          )}
        </>
      );
    },
    [rows]
  );

  const containerHeight = containerRef
    ? getTabContentAvailableHeight(containerRef, decreaseAvailableHeightBy ?? DEFAULT_MARGIN_BOTTOM)
    : 0;

  return (
    <EuiFlexGroup
      ref={setContainerRef}
      direction="column"
      gutterSize="none"
      responsive={false}
      css={
        containerHeight
          ? css`
              height: ${containerHeight}px;
            `
          : css`
              display: block;
            `
      }
    >
      <EuiFlexItem grow={false}>
        <EuiSpacer size="s" />
      </EuiFlexItem>

      <EuiFlexItem grow={false}>
        <TableFilters {...tableFiltersProps} allFields={allFields} />
      </EuiFlexItem>

      {rows.length === 0 ? (
        <EuiSelectableMessage style={{ minHeight: 300 }}>
          <p>
            <EuiI18n
              token="unifiedDocViewer.docViews.table.noFieldFound"
              default="No fields found"
            />
          </p>
        </EuiSelectableMessage>
      ) : (
        <>
          <EuiFlexItem grow={false}>
            <EuiSpacer size="s" />
          </EuiFlexItem>
          {isEsqlMode && (
            <EuiFlexItem
              grow={false}
              css={css`
                align-self: end;
                padding-bottom: ${euiTheme.size.s};
              `}
            >
              <EuiSwitch
                label={i18n.translate('unifiedDocViewer.hideNullValues.switchLabel', {
                  defaultMessage: 'Hide fields with null values',
                })}
                checked={areNullValuesHidden ?? false}
                onChange={onHideNullValuesChange}
                compressed
                data-test-subj="unifiedDocViewerHideNullValuesSwitch"
              />
            </EuiFlexItem>
          )}
          <EuiFlexItem
            grow={Boolean(containerHeight)}
            css={css`
              min-block-size: 0;
              display: block;
            `}
          >
            <EuiDataGrid
              key={`fields-table-${hit.id}`}
              {...GRID_PROPS}
              aria-label={i18n.translate('unifiedDocViewer.fieldsTable.ariaLabel', {
                defaultMessage: 'Field values',
              })}
              className="kbnDocViewer__fieldsGrid"
              columns={gridColumns}
              toolbarVisibility={false}
              rowCount={rows.length}
              renderCellValue={renderCellValue}
              renderCellPopover={renderCellPopover}
              pagination={pagination}
              leadingControlColumns={leadingControlColumns}
            />
          </EuiFlexItem>
        </>
      )}
    </EuiFlexGroup>
  );
};
