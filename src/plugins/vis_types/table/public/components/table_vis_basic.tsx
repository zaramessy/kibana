/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import React, { memo, useCallback, useMemo, useRef } from 'react';
import {
  EuiDataGrid,
  EuiDataGridProps,
  EuiDataGridRefProps,
  EuiDataGridSorting,
  EuiTitle,
} from '@elastic/eui';
import { i18n } from '@kbn/i18n';
import { IInterpreterRenderHandlers } from '@kbn/expressions-plugin/common';
import { createTableVisCell } from './table_vis_cell';
import { TableContext, TableVisConfig, TableVisUseUiStateProps } from '../types';
import { usePagination } from '../utils';
import { TableVisControls } from './table_vis_controls';
import { createGridColumns } from './table_vis_columns';
import { sortNullsLast } from './utils';

interface TableVisBasicProps {
  fireEvent: IInterpreterRenderHandlers['event'];
  table: TableContext;
  visConfig: TableVisConfig;
  title?: string;
  uiStateProps: TableVisUseUiStateProps;
}

export const TableVisBasic = memo(
  ({
    fireEvent,
    table,
    visConfig,
    title,
    uiStateProps: { columnsWidth, sort, setColumnsWidth, setSort },
  }: TableVisBasicProps) => {
    const dataGridRef = useRef<EuiDataGridRefProps>(null);

    const { columns, rows, formattedColumns } = table;

    // custom sorting is in place until the EuiDataGrid sorting gets rid of flaws -> https://github.com/elastic/eui/issues/4108
    const sortedRows = useMemo(() => {
      if (sort.columnIndex !== null && sort.direction) {
        const id = columns[sort.columnIndex]?.id;
        return sortNullsLast(rows, sort.direction, id);
      }

      return rows;
    }, [columns, rows, sort.columnIndex, sort.direction]);

    // renderCellValue is a component which renders a cell based on column and row indexes
    const renderCellValue = useMemo(
      () => createTableVisCell(sortedRows, formattedColumns, visConfig.autoFitRowToContent),
      [formattedColumns, sortedRows, visConfig.autoFitRowToContent]
    );

    const rowHeightsOptions = useMemo(
      () =>
        visConfig.autoFitRowToContent
          ? ({ defaultHeight: 'auto' } as unknown as EuiDataGridProps['rowHeightsOptions'])
          : undefined,
      [visConfig.autoFitRowToContent]
    );

    // Columns config
    const gridColumns = createGridColumns(
      columns,
      sortedRows,
      formattedColumns,
      columnsWidth,
      fireEvent,
      dataGridRef.current?.closeCellPopover
    );

    // Pagination config
    const pagination = usePagination(visConfig, rows.length);
    // Sorting config
    const sortingColumns = useMemo(
      () =>
        sort.columnIndex !== null && sort.direction
          ? [{ id: columns[sort.columnIndex]?.id, direction: sort.direction }]
          : [],
      [columns, sort]
    );
    const onSort = useCallback(
      (sortingCols: EuiDataGridSorting['columns'] | []) => {
        // data table vis sorting now only handles one column sorting
        // if data grid provides more columns to sort, pick only the next column to sort
        const newSortValue = sortingCols.length <= 1 ? sortingCols[0] : sortingCols[1];
        setSort(
          newSortValue && {
            columnIndex: columns.findIndex((c) => c.id === newSortValue.id),
            direction: newSortValue.direction,
          }
        );
      },
      [columns, setSort]
    );

    const dataGridAriaLabel =
      title ||
      visConfig.title ||
      i18n.translate('visTypeTable.defaultAriaLabel', {
        defaultMessage: 'Data table visualization',
      });

    const onColumnResize: EuiDataGridProps['onColumnResize'] = useCallback(
      ({ columnId, width }) => {
        const colIndex = columns.findIndex((c) => c.id === columnId);
        setColumnsWidth({
          colIndex,
          width,
        });
      },
      [columns, setColumnsWidth]
    );

    return (
      <>
        {title && (
          <EuiTitle size="xs">
            <h3>{title}</h3>
          </EuiTitle>
        )}
        <EuiDataGrid
          aria-label={dataGridAriaLabel}
          columns={gridColumns}
          gridStyle={{
            border: 'horizontal',
            header: 'underline',
          }}
          rowHeightsOptions={rowHeightsOptions}
          rowCount={rows.length}
          columnVisibility={{
            visibleColumns: columns.map(({ id }) => id),
            setVisibleColumns: () => {},
          }}
          toolbarVisibility={
            visConfig.showToolbar && {
              showColumnSelector: false,
              showFullScreenSelector: false,
              showSortSelector: false,
              showDisplaySelector: false,
              additionalControls: (
                <TableVisControls
                  dataGridAriaLabel={dataGridAriaLabel}
                  columns={columns}
                  // csv exports sorted table
                  rows={sortedRows}
                  filename={visConfig.title}
                />
              ),
            }
          }
          renderCellValue={renderCellValue}
          renderFooterCellValue={
            visConfig.showTotal
              ? ({ columnId }) => formattedColumns[columnId].formattedTotal || null
              : undefined
          }
          pagination={pagination}
          sorting={{ columns: sortingColumns, onSort }}
          onColumnResize={onColumnResize}
          minSizeForControls={1}
          ref={dataGridRef}
        />
      </>
    );
  }
);
