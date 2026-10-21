/**
 * Test for the AI extraction parsing logic.
 * Run: npx tsx scripts/test-vision-parse.ts
 */
import { normaliseExtraction } from '../services/pricing-service/src/vision';

let failures = 0;
const check = (name: string, actual: unknown, expected: unknown) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`        expected ${e}\n        actual   ${a}`);
};

// A realistic GPT-4o response for a price list laid out as
//   rows = widths (60,70,80), columns = drops (100,120,140)
const aiResponse = {
  tableName: 'Pleated Blinds - Trade Price List 2026',
  unitSystem: 'centimeters',
  widthValues: [60, 70, 80],
  dropValues: [100, 120, 140],
  rows: [
    { width: 60, prices: [48.5, 54.0, 60.25] },
    { width: 70, prices: [52.0, 58.4, 65.15] },
    { width: 80, prices: [56.75, 63.9, 71.2] }
  ]
};

console.log('\n=== normaliseExtraction ===');
const table = normaliseExtraction(aiResponse);

check('name', table?.name, 'Pleated Blinds - Trade Price List 2026');
check('unitSystem', table?.unitSystem, 'centimeters');
check('widthValues', table?.widthValues, [60, 70, 80]);
check('dropValues', table?.dropValues, [100, 120, 140]);

// priceMatrix is [dropIndex][widthIndex] - the app's existing shape
check('priceMatrix is drop-major', table?.priceMatrix, [
  [48.5, 52.0, 56.75], // drop 100, across widths 60/70/80
  [54.0, 58.4, 63.9],  // drop 120
  [60.25, 65.15, 71.2] // drop 140
]);

// The CSV must be one line per WIDTH with values across the DROPS,
// because the grid paste handler does matrix[targetCol][targetRow]
// where targetCol comes from the position in the line and targetRow from the line index.
check('csv orientation (line = width, values across = drops)', table?.csv, [
  '48.5\t54\t60.25',
  '52\t58.4\t65.15',
  '56.75\t63.9\t71.2'
].join('\n'));

// Round-trip: pasting the CSV at cell (0,0) must reproduce the matrix
const lines = table!.csv.split('\n');
const pasted: (number | null)[][] = Array.from({ length: table!.dropValues.length }, () =>
  Array.from({ length: table!.widthValues.length }, () => null)
);
lines.forEach((line, lineIndex) => {
  line.split('\t').forEach((value, colIndex) => {
    pasted[colIndex][lineIndex] = value === '' ? null : Number(value);
  });
});
check('csv round-trips back to the matrix', pasted, table?.priceMatrix);

console.log('\n=== edge cases ===');
// Missing price -> null
const withGap = normaliseExtraction({
  tableName: 'Gappy', unitSystem: 'inches',
  widthValues: [10, 20], dropValues: [30, 40],
  rows: [{ width: 10, prices: [5, null] }, { width: 20, prices: [6, 7] }]
});
check('null preserved for a missing price', withGap?.priceMatrix, [[5, 6], [null, 7]]);
check('inches detected', withGap?.unitSystem, 'inches');

// Currency symbols and stray text in the numbers
const messy = normaliseExtraction({
  tableName: 'Messy', unitSystem: 'centimeters',
  widthValues: [40], dropValues: [50],
  rows: [{ width: 40, prices: ['£48.50'] }]
});
check('currency symbol stripped', messy?.priceMatrix, [[48.5]]);

// Not a pricing table
check('empty rows -> null', normaliseExtraction({ tableName: '', rows: [] }), null);
check('garbage -> null', normaliseExtraction('not an object'), null);
check('null -> null', normaliseExtraction(null), null);

// Unsorted widths should be sorted
const unsorted = normaliseExtraction({
  tableName: 'Unsorted', unitSystem: 'centimeters',
  widthValues: [80, 60, 70], dropValues: [100, 120],
  rows: [{ width: 80, prices: [3, 4] }, { width: 60, prices: [1, 2] }, { width: 70, prices: [1.5, 2.5] }]
});
check('widths sorted ascending', unsorted?.widthValues, [60, 70, 80]);
check('rows re-ordered to match sorted widths', unsorted?.priceMatrix, [[1, 1.5, 3], [2, 2.5, 4]]);

console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : failures + ' TEST(S) FAILED'}\n`);
process.exit(failures === 0 ? 0 : 1);
