/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import expect from '@kbn/expect';
import kbnRison from '@kbn/rison';
import { FtrProviderContext } from '../ftr_provider_context';

export default function ({ getService, getPageObjects }: FtrProviderContext) {
  const esArchiver = getService('esArchiver');
  const kibanaServer = getService('kibanaServer');
  const log = getService('log');
  const dataGrid = getService('dataGrid');
  const testSubjects = getService('testSubjects');
  const monacoEditor = getService('monacoEditor');
  const security = getService('security');
  const inspector = getService('inspector');
  const retry = getService('retry');
  const browser = getService('browser');
  const find = getService('find');
  const esql = getService('esql');
  const dashboardAddPanel = getService('dashboardAddPanel');
  const PageObjects = getPageObjects([
    'common',
    'discover',
    'dashboard',
    'header',
    'timePicker',
    'unifiedFieldList',
  ]);

  const defaultSettings = {
    defaultIndex: 'logstash-*',
    enableESQL: true,
  };

  describe('discover esql view', function () {
    before(async () => {
      await kibanaServer.savedObjects.cleanStandardList();
      await security.testUser.setRoles(['kibana_admin', 'test_logstash_reader']);
      log.debug('load kibana index with default index pattern');
      await kibanaServer.importExport.load('test/functional/fixtures/kbn_archiver/discover');
      // and load a set of makelogs data
      await esArchiver.loadIfNeeded('test/functional/fixtures/es_archiver/logstash_functional');
      await esArchiver.load('test/functional/fixtures/es_archiver/kibana_sample_data_flights');
      await kibanaServer.importExport.load(
        'test/functional/fixtures/kbn_archiver/kibana_sample_data_flights_index_pattern'
      );
      await kibanaServer.uiSettings.replace(defaultSettings);
      await PageObjects.timePicker.setDefaultAbsoluteRangeViaUiSettings();
      await PageObjects.common.navigateToApp('discover');
    });

    after(async () => {
      await PageObjects.timePicker.resetDefaultAbsoluteRangeViaUiSettings();
    });

    describe('ES|QL in Discover', () => {
      it('should render esql view correctly', async function () {
        await PageObjects.unifiedFieldList.waitUntilSidebarHasLoaded();

        expect(await testSubjects.exists('showQueryBarMenu')).to.be(true);
        expect(await testSubjects.exists('superDatePickerToggleQuickMenuButton')).to.be(true);
        expect(await testSubjects.exists('addFilter')).to.be(true);
        expect(await testSubjects.exists('dscViewModeDocumentButton')).to.be(true);
        expect(await testSubjects.exists('unifiedHistogramChart')).to.be(true);
        expect(await testSubjects.exists('discoverQueryHits')).to.be(true);
        expect(await testSubjects.exists('discoverAlertsButton')).to.be(true);
        expect(await testSubjects.exists('shareTopNavButton')).to.be(true);
        expect(await testSubjects.exists('docTableExpandToggleColumn')).to.be(true);
        expect(await testSubjects.exists('dataGridColumnSortingButton')).to.be(true);
        expect(await testSubjects.exists('fieldListFiltersFieldSearch')).to.be(true);
        expect(await testSubjects.exists('fieldListFiltersFieldTypeFilterToggle')).to.be(true);
        await testSubjects.click('field-@message-showDetails');
        expect(await testSubjects.exists('discoverFieldListPanelEdit-@message')).to.be(true);

        await PageObjects.discover.selectTextBaseLang();
        await PageObjects.unifiedFieldList.waitUntilSidebarHasLoaded();

        expect(await testSubjects.exists('fieldListFiltersFieldSearch')).to.be(true);
        expect(await testSubjects.exists('TextBasedLangEditor')).to.be(true);
        expect(await testSubjects.exists('superDatePickerToggleQuickMenuButton')).to.be(true);

        expect(await testSubjects.exists('showQueryBarMenu')).to.be(false);
        expect(await testSubjects.exists('addFilter')).to.be(false);
        expect(await testSubjects.exists('dscViewModeDocumentButton')).to.be(true);
        // when Lens suggests a table, we render an ESQL based histogram
        expect(await testSubjects.exists('unifiedHistogramChart')).to.be(true);
        expect(await testSubjects.exists('discoverQueryHits')).to.be(true);
        expect(await testSubjects.exists('discoverAlertsButton')).to.be(true);
        expect(await testSubjects.exists('shareTopNavButton')).to.be(true);
        // we don't sort for the Document view
        expect(await testSubjects.exists('dataGridColumnSortingButton')).to.be(false);
        expect(await testSubjects.exists('docTableExpandToggleColumn')).to.be(true);
        expect(await testSubjects.exists('fieldListFiltersFieldTypeFilterToggle')).to.be(true);
        await testSubjects.click('field-@message-showDetails');
        expect(await testSubjects.exists('discoverFieldListPanelEditItem')).to.be(false);
      });

      it('should not render the histogram for indices with no @timestamp field', async function () {
        await PageObjects.discover.selectTextBaseLang();
        await PageObjects.unifiedFieldList.waitUntilSidebarHasLoaded();

        const testQuery = `from kibana_sample_data_flights | limit 10`;

        await monacoEditor.setCodeEditorValue(testQuery);
        await testSubjects.click('querySubmitButton');
        await PageObjects.header.waitUntilLoadingHasFinished();
        await PageObjects.discover.waitUntilSearchingHasFinished();

        expect(await testSubjects.exists('TextBasedLangEditor')).to.be(true);
        // I am not rendering the histogram for indices with no @timestamp field
        expect(await testSubjects.exists('unifiedHistogramChart')).to.be(false);
      });

      it('should render the histogram for indices with no @timestamp field when the ?t_start, ?t_end params are in the query', async function () {
        await PageObjects.discover.selectTextBaseLang();
        await PageObjects.unifiedFieldList.waitUntilSidebarHasLoaded();

        const testQuery = `from kibana_sample_data_flights | limit 10 | where timestamp >= ?t_start and timestamp <= ?t_end`;

        await monacoEditor.setCodeEditorValue(testQuery);
        await testSubjects.click('querySubmitButton');
        await PageObjects.header.waitUntilLoadingHasFinished();
        await PageObjects.discover.waitUntilSearchingHasFinished();

        const fromTime = 'Apr 10, 2018 @ 00:00:00.000';
        const toTime = 'Nov 15, 2018 @ 00:00:00.000';
        await PageObjects.timePicker.setAbsoluteRange(fromTime, toTime);

        expect(await testSubjects.exists('TextBasedLangEditor')).to.be(true);
        expect(await testSubjects.exists('unifiedHistogramChart')).to.be(true);
      });

      it('should perform test query correctly', async function () {
        await PageObjects.timePicker.setDefaultAbsoluteRange();
        await PageObjects.discover.selectTextBaseLang();
        const testQuery = `from logstash-* | limit 10 | stats countB = count(bytes) by geo.dest | sort countB`;

        await monacoEditor.setCodeEditorValue(testQuery);
        await testSubjects.click('querySubmitButton');
        await PageObjects.header.waitUntilLoadingHasFinished();
        await PageObjects.discover.waitUntilSearchingHasFinished();
        // here Lens suggests a XY so it is rendered
        expect(await testSubjects.exists('unifiedHistogramChart')).to.be(true);
        expect(await testSubjects.exists('xyVisChart')).to.be(true);
        const cell = await dataGrid.getCellElementExcludingControlColumns(0, 0);
        expect(await cell.getVisibleText()).to.be('1');
      });

      it('should render when switching to a time range with no data, then back to a time range with data', async () => {
        await PageObjects.discover.selectTextBaseLang();
        const testQuery = `from logstash-* | limit 10 | stats countB = count(bytes) by geo.dest | sort countB`;
        await monacoEditor.setCodeEditorValue(testQuery);
        await testSubjects.click('querySubmitButton');
        await PageObjects.header.waitUntilLoadingHasFinished();
        await PageObjects.discover.waitUntilSearchingHasFinished();
        let cell = await dataGrid.getCellElementExcludingControlColumns(0, 0);
        expect(await cell.getVisibleText()).to.be('1');
        await PageObjects.timePicker.setAbsoluteRange(
          'Sep 19, 2015 @ 06:31:44.000',
          'Sep 19, 2015 @ 06:31:44.000'
        );
        await PageObjects.header.waitUntilLoadingHasFinished();
        await PageObjects.discover.waitUntilSearchingHasFinished();
        expect(await testSubjects.exists('discoverNoResults')).to.be(true);
        await PageObjects.timePicker.setDefaultAbsoluteRange();
        await PageObjects.header.waitUntilLoadingHasFinished();
        await PageObjects.discover.waitUntilSearchingHasFinished();
        cell = await dataGrid.getCellElementExcludingControlColumns(0, 0);
        expect(await cell.getVisibleText()).to.be('1');
      });

      it('should query an index pattern that doesnt translate to a dataview correctly', async function () {
        await PageObjects.discover.selectTextBaseLang();
        const testQuery = `from logstash* | limit 10 | stats countB = count(bytes) by geo.dest | sort countB`;

        await monacoEditor.setCodeEditorValue(testQuery);
        await testSubjects.click('querySubmitButton');
        await PageObjects.header.waitUntilLoadingHasFinished();

        const cell = await dataGrid.getCellElementExcludingControlColumns(0, 0);
        expect(await cell.getVisibleText()).to.be('1');
      });

      it('should render correctly if there are empty fields', async function () {
        await PageObjects.discover.selectTextBaseLang();
        const testQuery = `from logstash-* | limit 10 | keep machine.ram_range, bytes`;

        await monacoEditor.setCodeEditorValue(testQuery);
        await testSubjects.click('querySubmitButton');
        await PageObjects.header.waitUntilLoadingHasFinished();
        await PageObjects.discover.waitUntilSearchingHasFinished();
        const cell = await dataGrid.getCellElementExcludingControlColumns(0, 1);
        expect(await cell.getVisibleText()).to.be(' - ');
        expect(await dataGrid.getHeaders()).to.eql([
          'Select column',
          'Control column',
          'Numberbytes',
          'machine.ram_range',
        ]);
      });

      it('should work without a FROM statement', async function () {
        await PageObjects.discover.selectTextBaseLang();
        const testQuery = `ROW a = 1, b = "two", c = null`;

        await monacoEditor.setCodeEditorValue(testQuery);
        await testSubjects.click('querySubmitButton');
        await PageObjects.header.waitUntilLoadingHasFinished();

        await PageObjects.discover.dragFieldToTable('a');
        const cell = await dataGrid.getCellElementExcludingControlColumns(0, 0);
        expect(await cell.getVisibleText()).to.be('1');
      });
    });

    describe('errors', () => {
      it('should show error messages for syntax errors in query', async function () {
        await PageObjects.discover.selectTextBaseLang();
        const brokenQueries = [
          'from logstash-* | limit 10*',
          'from logstash-* | limit A',
          'from logstash-* | where a*',
          'limit 10',
        ];
        for (const testQuery of brokenQueries) {
          await monacoEditor.setCodeEditorValue(testQuery);
          await testSubjects.click('querySubmitButton');
          await PageObjects.header.waitUntilLoadingHasFinished();
          await PageObjects.discover.waitUntilSearchingHasFinished();
          // error in fetching documents because of the invalid query
          await PageObjects.discover.showsErrorCallout();
          const message = await testSubjects.getVisibleText('discoverErrorCalloutMessage');
          expect(message).to.contain(
            "[esql] > Couldn't parse Elasticsearch ES|QL query. Check your query and try again."
          );
          expect(message).to.not.contain('undefined');
          if (message.includes('line')) {
            expect((await monacoEditor.getCurrentMarkers('kibanaCodeEditor')).length).to.eql(1);
          }
        }
      });
    });

    describe('switch modal', () => {
      beforeEach(async () => {
        await PageObjects.common.navigateToApp('discover');
        await PageObjects.timePicker.setDefaultAbsoluteRange();
      });

      it('should show switch modal when switching to a data view', async () => {
        await PageObjects.discover.selectTextBaseLang();
        await PageObjects.header.waitUntilLoadingHasFinished();
        await PageObjects.discover.waitUntilSearchingHasFinished();
        await testSubjects.click('switch-to-dataviews');
        await retry.try(async () => {
          await testSubjects.existOrFail('discover-esql-to-dataview-modal');
        });
      });

      it('should not show switch modal when switching to a data view while a saved search is open', async () => {
        await PageObjects.discover.selectTextBaseLang();
        const testQuery = 'from logstash-* | limit 100 | drop @timestamp';
        await monacoEditor.setCodeEditorValue(testQuery);
        await testSubjects.click('querySubmitButton');
        await PageObjects.header.waitUntilLoadingHasFinished();
        await PageObjects.discover.waitUntilSearchingHasFinished();
        await testSubjects.click('switch-to-dataviews');
        await retry.try(async () => {
          await testSubjects.existOrFail('discover-esql-to-dataview-modal');
        });
        await find.clickByCssSelector(
          '[data-test-subj="discover-esql-to-dataview-modal"] .euiModal__closeIcon'
        );
        await retry.try(async () => {
          await testSubjects.missingOrFail('discover-esql-to-dataview-modal');
        });
        await PageObjects.discover.saveSearch('esql_test');
        await testSubjects.click('switch-to-dataviews');
        await testSubjects.missingOrFail('discover-esql-to-dataview-modal');
      });

      it('should show switch modal when switching to a data view while a saved search with unsaved changes is open', async () => {
        await PageObjects.discover.selectTextBaseLang();
        await PageObjects.header.waitUntilLoadingHasFinished();
        await PageObjects.discover.waitUntilSearchingHasFinished();
        await PageObjects.discover.saveSearch('esql_test2');
        const testQuery = 'from logstash-* | limit 100 | drop @timestamp';
        await monacoEditor.setCodeEditorValue(testQuery);
        await testSubjects.click('querySubmitButton');
        await PageObjects.header.waitUntilLoadingHasFinished();
        await PageObjects.discover.waitUntilSearchingHasFinished();
        await testSubjects.click('switch-to-dataviews');
        await retry.try(async () => {
          await testSubjects.existOrFail('discover-esql-to-dataview-modal');
        });
      });
    });

    describe('inspector', () => {
      beforeEach(async () => {
        await PageObjects.common.navigateToApp('discover');
        await PageObjects.timePicker.setDefaultAbsoluteRange();
        await PageObjects.header.waitUntilLoadingHasFinished();
        await PageObjects.discover.waitUntilSearchingHasFinished();
      });

      it('shows Discover and Lens requests in Inspector', async () => {
        await PageObjects.discover.selectTextBaseLang();
        await PageObjects.header.waitUntilLoadingHasFinished();
        await PageObjects.discover.waitUntilSearchingHasFinished();
        let retries = 0;
        await retry.try(async () => {
          if (retries > 0) {
            await inspector.close();
            await testSubjects.click('querySubmitButton');
            await PageObjects.header.waitUntilLoadingHasFinished();
            await PageObjects.discover.waitUntilSearchingHasFinished();
          }
          await inspector.open();
          retries = retries + 1;
          const requestNames = await inspector.getRequestNames();
          expect(requestNames).to.contain('Table');
          expect(requestNames).to.contain('Visualization');
        });
      });

      describe('with slow queries', () => {
        it('should show only one entry in inspector for table/visualization', async function () {
          const state = kbnRison.encode({
            dataSource: { type: 'esql' },
            query: { esql: 'from kibana_sample_data_flights' },
          });
          await PageObjects.common.navigateToActualUrl('discover', `?_a=${state}`, {
            ensureCurrentUrl: false,
          });
          await PageObjects.discover.selectTextBaseLang();
          const testQuery = `from logstash-* | limit 10`;
          await monacoEditor.setCodeEditorValue(testQuery);

          await browser.execute(() => {
            window.ELASTIC_ESQL_DELAY_SECONDS = 5;
          });
          await testSubjects.click('querySubmitButton');
          await PageObjects.header.waitUntilLoadingHasFinished();
          await browser.execute(() => {
            window.ELASTIC_ESQL_DELAY_SECONDS = undefined;
          });

          await inspector.open();
          const requestNames = (await inspector.getRequestNames()).split(',');
          const requestTotalTime = await inspector.getRequestTotalTime();
          expect(requestTotalTime).to.be.greaterThan(5000);
          expect(requestNames.length).to.be(2);
          expect(requestNames).to.contain('Table');
          expect(requestNames).to.contain('Visualization');
        });
      });
    });

    describe('query history', () => {
      beforeEach(async () => {
        await PageObjects.common.navigateToApp('discover');
        await PageObjects.timePicker.setDefaultAbsoluteRange();
      });

      it('should see my current query in the history', async () => {
        await PageObjects.discover.selectTextBaseLang();
        await PageObjects.header.waitUntilLoadingHasFinished();
        await PageObjects.discover.waitUntilSearchingHasFinished();
        await PageObjects.unifiedFieldList.waitUntilSidebarHasLoaded();

        await testSubjects.click('TextBasedLangEditor-toggle-query-history-button');
        const historyItems = await esql.getHistoryItems();
        log.debug(historyItems);
        const queryAdded = historyItems.some((item) => {
          return item[1] === 'FROM logstash-* | LIMIT 10';
        });

        expect(queryAdded).to.be(true);
      });

      it('updating the query should add this to the history', async () => {
        await PageObjects.discover.selectTextBaseLang();
        await PageObjects.header.waitUntilLoadingHasFinished();
        await PageObjects.discover.waitUntilSearchingHasFinished();
        await PageObjects.unifiedFieldList.waitUntilSidebarHasLoaded();

        const testQuery = 'from logstash-* | limit 100 | drop @timestamp';
        await monacoEditor.setCodeEditorValue(testQuery);
        await testSubjects.click('querySubmitButton');
        await PageObjects.header.waitUntilLoadingHasFinished();
        await PageObjects.discover.waitUntilSearchingHasFinished();

        await testSubjects.click('TextBasedLangEditor-toggle-query-history-button');
        const historyItems = await esql.getHistoryItems();
        log.debug(historyItems);
        const queryAdded = historyItems.some((item) => {
          return item[1] === 'from logstash-* | limit 100 | drop @timestamp';
        });

        expect(queryAdded).to.be(true);
      });

      it('should select a query from the history and submit it', async () => {
        await PageObjects.discover.selectTextBaseLang();
        await PageObjects.header.waitUntilLoadingHasFinished();
        await PageObjects.discover.waitUntilSearchingHasFinished();
        await PageObjects.unifiedFieldList.waitUntilSidebarHasLoaded();

        await testSubjects.click('TextBasedLangEditor-toggle-query-history-button');
        // click a history item
        await esql.clickHistoryItem(1);

        const historyItems = await esql.getHistoryItems();
        log.debug(historyItems);
        const queryAdded = historyItems.some((item) => {
          return item[1] === 'from logstash-* | limit 100 | drop @timestamp';
        });

        expect(queryAdded).to.be(true);
      });

      it('should add a failed query to the history', async () => {
        await PageObjects.discover.selectTextBaseLang();
        await PageObjects.header.waitUntilLoadingHasFinished();
        await PageObjects.discover.waitUntilSearchingHasFinished();
        await PageObjects.unifiedFieldList.waitUntilSidebarHasLoaded();

        const testQuery = 'from logstash-* | limit 100 | woof and meow';
        await monacoEditor.setCodeEditorValue(testQuery);
        await testSubjects.click('querySubmitButton');
        await PageObjects.header.waitUntilLoadingHasFinished();
        await PageObjects.discover.waitUntilSearchingHasFinished();

        await testSubjects.click('TextBasedLangEditor-toggle-query-history-button');
        const historyItem = await esql.getHistoryItem(0);
        await historyItem.findByTestSubject('TextBasedLangEditor-queryHistory-error');
      });
    });

    describe('sorting', () => {
      it('should sort correctly', async () => {
        const savedSearchName = 'testSorting';

        await PageObjects.discover.selectTextBaseLang();
        await PageObjects.header.waitUntilLoadingHasFinished();
        await PageObjects.discover.waitUntilSearchingHasFinished();

        const testQuery = 'from logstash-* | sort @timestamp | limit 100';
        await monacoEditor.setCodeEditorValue(testQuery);
        await testSubjects.click('querySubmitButton');
        await PageObjects.header.waitUntilLoadingHasFinished();
        await PageObjects.discover.waitUntilSearchingHasFinished();
        await PageObjects.unifiedFieldList.waitUntilSidebarHasLoaded();

        await PageObjects.unifiedFieldList.clickFieldListItemAdd('bytes');

        await PageObjects.header.waitUntilLoadingHasFinished();
        await PageObjects.discover.waitUntilSearchingHasFinished();

        await retry.waitFor('first cell contains an initial value', async () => {
          const cell = await dataGrid.getCellElementExcludingControlColumns(0, 0);
          const text = await cell.getVisibleText();
          return text === '1,623';
        });

        expect(await testSubjects.getVisibleText('dataGridColumnSortingButton')).to.be(
          'Sort fields'
        );

        await dataGrid.clickDocSortDesc('bytes', 'Sort High-Low');

        await PageObjects.discover.waitUntilSearchingHasFinished();

        await retry.waitFor('first cell contains the highest value', async () => {
          const cell = await dataGrid.getCellElementExcludingControlColumns(0, 0);
          const text = await cell.getVisibleText();
          return text === '17,966';
        });

        expect(await testSubjects.getVisibleText('dataGridColumnSortingButton')).to.be(
          'Sort fields\n1'
        );

        await PageObjects.discover.saveSearch(savedSearchName);

        await PageObjects.header.waitUntilLoadingHasFinished();
        await PageObjects.discover.waitUntilSearchingHasFinished();

        await retry.waitFor('first cell contains the same highest value', async () => {
          const cell = await dataGrid.getCellElementExcludingControlColumns(0, 0);
          const text = await cell.getVisibleText();
          return text === '17,966';
        });

        await browser.refresh();

        await PageObjects.header.waitUntilLoadingHasFinished();
        await PageObjects.discover.waitUntilSearchingHasFinished();

        await retry.waitFor('first cell contains the same highest value after reload', async () => {
          const cell = await dataGrid.getCellElementExcludingControlColumns(0, 0);
          const text = await cell.getVisibleText();
          return text === '17,966';
        });

        await PageObjects.discover.clickNewSearchButton();

        await PageObjects.header.waitUntilLoadingHasFinished();
        await PageObjects.discover.waitUntilSearchingHasFinished();

        await PageObjects.discover.loadSavedSearch(savedSearchName);

        await PageObjects.header.waitUntilLoadingHasFinished();
        await PageObjects.discover.waitUntilSearchingHasFinished();

        await retry.waitFor(
          'first cell contains the same highest value after reopening',
          async () => {
            const cell = await dataGrid.getCellElementExcludingControlColumns(0, 0);
            const text = await cell.getVisibleText();
            return text === '17,966';
          }
        );

        await dataGrid.clickDocSortDesc('bytes', 'Sort Low-High');

        await PageObjects.discover.waitUntilSearchingHasFinished();

        await retry.waitFor('first cell contains the lowest value', async () => {
          const cell = await dataGrid.getCellElementExcludingControlColumns(0, 0);
          const text = await cell.getVisibleText();
          return text === '0';
        });

        expect(await testSubjects.getVisibleText('dataGridColumnSortingButton')).to.be(
          'Sort fields\n1'
        );

        await PageObjects.unifiedFieldList.clickFieldListItemAdd('extension');

        await PageObjects.header.waitUntilLoadingHasFinished();
        await PageObjects.discover.waitUntilSearchingHasFinished();

        await dataGrid.clickDocSortDesc('extension', 'Sort A-Z');

        await retry.waitFor('first cell contains the lowest value for extension', async () => {
          const cell = await dataGrid.getCellElementExcludingControlColumns(0, 1);
          const text = await cell.getVisibleText();
          return text === 'css';
        });

        expect(await testSubjects.getVisibleText('dataGridColumnSortingButton')).to.be(
          'Sort fields\n2'
        );

        await browser.refresh();

        await PageObjects.header.waitUntilLoadingHasFinished();
        await PageObjects.discover.waitUntilSearchingHasFinished();

        await retry.waitFor('first cell contains the same lowest value after reload', async () => {
          const cell = await dataGrid.getCellElementExcludingControlColumns(0, 0);
          const text = await cell.getVisibleText();
          return text === '0';
        });

        await retry.waitFor(
          'first cell contains the same lowest value for extension after reload',
          async () => {
            const cell = await dataGrid.getCellElementExcludingControlColumns(0, 1);
            const text = await cell.getVisibleText();
            return text === 'css';
          }
        );

        await PageObjects.discover.saveSearch(savedSearchName);

        await PageObjects.common.navigateToApp('dashboard');
        await PageObjects.dashboard.clickNewDashboard();
        await PageObjects.timePicker.setDefaultAbsoluteRange();
        await dashboardAddPanel.clickOpenAddPanel();
        await dashboardAddPanel.addSavedSearch(savedSearchName);
        await PageObjects.header.waitUntilLoadingHasFinished();

        await retry.waitFor(
          'first cell contains the same lowest value as dashboard panel',
          async () => {
            const cell = await dataGrid.getCellElementExcludingControlColumns(0, 0);
            const text = await cell.getVisibleText();
            return text === '0';
          }
        );

        await retry.waitFor(
          'first cell contains the lowest value for extension as dashboard panel',
          async () => {
            const cell = await dataGrid.getCellElementExcludingControlColumns(0, 1);
            const text = await cell.getVisibleText();
            return text === 'css';
          }
        );

        expect(await testSubjects.getVisibleText('dataGridColumnSortingButton')).to.be(
          'Sort fields\n2'
        );
      });
    });

    describe('filtering by clicking on the table', () => {
      beforeEach(async () => {
        await PageObjects.common.navigateToApp('discover');
        await PageObjects.timePicker.setDefaultAbsoluteRange();
      });

      it('should append a where clause by clicking the table', async () => {
        await PageObjects.discover.selectTextBaseLang();
        const testQuery = `from logstash-* | sort @timestamp desc | limit 10000 | stats countB = count(bytes) by geo.dest | sort countB`;
        await monacoEditor.setCodeEditorValue(testQuery);

        await testSubjects.click('querySubmitButton');
        await PageObjects.header.waitUntilLoadingHasFinished();
        await PageObjects.discover.waitUntilSearchingHasFinished();
        await PageObjects.unifiedFieldList.waitUntilSidebarHasLoaded();

        await dataGrid.clickCellFilterForButtonExcludingControlColumns(0, 1);
        await PageObjects.header.waitUntilLoadingHasFinished();
        await PageObjects.discover.waitUntilSearchingHasFinished();
        await PageObjects.unifiedFieldList.waitUntilSidebarHasLoaded();

        const editorValue = await monacoEditor.getCodeEditorValue();
        expect(editorValue).to.eql(
          `from logstash-* | sort @timestamp desc | limit 10000 | stats countB = count(bytes) by geo.dest | sort countB\n| WHERE \`geo.dest\`=="BT"`
        );

        // negate
        await dataGrid.clickCellFilterOutButtonExcludingControlColumns(0, 1);
        await PageObjects.header.waitUntilLoadingHasFinished();
        await PageObjects.discover.waitUntilSearchingHasFinished();
        await PageObjects.unifiedFieldList.waitUntilSidebarHasLoaded();

        const newValue = await monacoEditor.getCodeEditorValue();
        expect(newValue).to.eql(
          `from logstash-* | sort @timestamp desc | limit 10000 | stats countB = count(bytes) by geo.dest | sort countB\n| WHERE \`geo.dest\`!="BT"`
        );
      });

      it('should append an end in existing where clause by clicking the table', async () => {
        await PageObjects.discover.selectTextBaseLang();
        const testQuery = `from logstash-* | sort @timestamp desc | limit 10000 | stats countB = count(bytes) by geo.dest | sort countB | where countB > 0`;
        await monacoEditor.setCodeEditorValue(testQuery);

        await testSubjects.click('querySubmitButton');
        await PageObjects.header.waitUntilLoadingHasFinished();
        await PageObjects.discover.waitUntilSearchingHasFinished();
        await PageObjects.unifiedFieldList.waitUntilSidebarHasLoaded();

        await dataGrid.clickCellFilterForButtonExcludingControlColumns(0, 1);
        await PageObjects.header.waitUntilLoadingHasFinished();
        await PageObjects.discover.waitUntilSearchingHasFinished();
        await PageObjects.unifiedFieldList.waitUntilSidebarHasLoaded();

        const editorValue = await monacoEditor.getCodeEditorValue();
        expect(editorValue).to.eql(
          `from logstash-* | sort @timestamp desc | limit 10000 | stats countB = count(bytes) by geo.dest | sort countB | where countB > 0\nAND \`geo.dest\`=="BT"`
        );
      });
    });
  });
}
