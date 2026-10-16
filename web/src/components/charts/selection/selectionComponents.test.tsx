import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LegendSwatch, NothingSelected, SelectableDataTable, SelectableLegend, SelectableTable, SelectionNote, useSeriesSelection, type SelectableColumn, type SelectableRow } from '.';

const COLUMNS: SelectableColumn[] = [
  { key: 'declared', label: 'Declared' },
  { key: 'estimated', label: 'Estimated' },
  { key: 'total', label: 'Total', selectable: false },
];
const ROWS: SelectableRow[] = [
  { id: 'jan', header: 'Jan', cells: ['1', '2', '3'] },
  { id: 'feb', header: 'Feb', cells: ['4', '5', '9'] },
  { id: 'sum', header: 'Sum', cells: ['5', '7', '12'], selectable: false },
];

function Harness({ legend = true, table = true, extra }: Readonly<{ legend?: boolean; table?: boolean; extra?: boolean }>) {
  const selection = useSeriesSelection(['declared', 'estimated'], ['jan', 'feb', 'sum']);
  return (
    <div>
      {legend && (
        <SelectableLegend
          selection={selection}
          entries={[
            { key: 'declared', label: 'Declared', swatch: <LegendSwatch color="#00f" edge="#009" /> },
            { key: 'estimated', label: 'Estimated', swatch: <LegendSwatch color="#ff0" edge="#990" dashed /> },
            { key: 'avg', label: 'Average', swatch: <LegendSwatch shape="line" color="#000" dashed />, toggleable: false },
          ]}
        />
      )}
      {table && <SelectableTable caption="Numbers" rowHeader="Month" columns={COLUMNS} rows={ROWS} selection={selection} />}
      {extra && <SelectableDataTable caption="Numbers in details" rowHeader="Month" columns={COLUMNS} rows={ROWS} selection={selection} extra={<p>More</p>} />}
      <output data-testid="state">{[...selection.hiddenSeries, ...selection.hiddenRows].join(',')}</output>
      <output data-testid="empty">{String(selection.nothingSelected)}</output>
    </div>
  );
}

describe('SelectableLegend', () => {
  it('shows every entry as a pressed toggle, and the plain entry as text', () => {
    render(<Harness table={false} />);
    const legend = screen.getByRole('list', { name: 'Legend' });
    expect(within(legend).getAllByRole('button')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Declared' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(legend).getByText('Average')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Average' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Show all' })).toBeNull();
    expect(screen.queryByTestId('selection-note')).toBeNull();
  });

  it('excludes an entry (struck through, not pressed) and includes it again; Show all resets', async () => {
    const user = userEvent.setup();
    render(<Harness table={false} />);
    await user.click(screen.getByRole('button', { name: 'Declared' }));
    expect(screen.getByRole('button', { name: 'Declared' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByText('Declared')).toHaveClass('line-through');
    expect(screen.getByTestId('selection-note')).toHaveTextContent('Chart shows the current selection');
    await user.click(screen.getByRole('button', { name: 'Declared' }));
    expect(screen.getByRole('button', { name: 'Declared' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Declared')).not.toHaveClass('line-through');
    await user.click(screen.getByRole('button', { name: 'Estimated' }));
    await user.click(screen.getByRole('button', { name: 'Show all' }));
    expect(screen.getByTestId('state')).toBeEmptyDOMElement();
    expect(screen.queryByRole('button', { name: 'Show all' })).toBeNull();
  });

  it('is operable with the keyboard', async () => {
    const user = userEvent.setup();
    render(<Harness table={false} />);
    await user.tab();
    expect(screen.getByRole('button', { name: 'Declared' })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('button', { name: 'Declared' })).toHaveAttribute('aria-pressed', 'false');
    await user.keyboard(' ');
    expect(screen.getByRole('button', { name: 'Declared' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('uses the given list name and test id', () => {
    const selection = { isSeriesVisible: () => true, isRowVisible: () => true, toggleSeries: () => {}, toggleRow: () => {}, hasHidden: false, reset: () => {} };
    render(<SelectableLegend entries={[]} selection={selection} label="Holdings legend" testId="my-legend" className="mt-2" />);
    expect(screen.getByRole('list', { name: 'Holdings legend' })).toBeInTheDocument();
    expect(screen.getByTestId('my-legend')).toHaveClass('mt-2');
  });
});

describe('LegendSwatch', () => {
  it('draws squares, dots and lines, hidden from assistive technology', () => {
    const { container } = render(
      <>
        <LegendSwatch color="#f00" />
        <LegendSwatch shape="dot" color="#0f0" />
        <LegendSwatch shape="line" color="#00f" dashed />
      </>,
    );
    const [square, dot, line] = [...container.querySelectorAll('span')] as HTMLElement[];
    expect(square).toHaveClass('rounded-sm');
    expect(dot).toHaveClass('rounded-full');
    expect(line).toHaveClass('border-t-2');
    expect(line!.style.borderTopStyle).toBe('dashed');
    expect(square).toHaveAttribute('aria-hidden', 'true');
  });
});

describe('SelectableTable', () => {
  it('is a real table whose series columns and rows are toggles, with a hint', () => {
    render(<Harness legend={false} />);
    const table = screen.getByRole('table', { name: 'Numbers' });
    expect(table).toHaveAccessibleDescription('Click a column or row header to include or exclude it from the chart');
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Month', 'Declared', 'Estimated', 'Total']);
    expect(within(table).getByRole('button', { name: 'Declared' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(table).getByRole('button', { name: 'Jan' })).toHaveAttribute('aria-pressed', 'true');
    // totals column and totals row are plain text
    expect(within(table).queryByRole('button', { name: 'Total' })).toBeNull();
    expect(within(table).queryByRole('button', { name: 'Sum' })).toBeNull();
    expect(within(table).getByRole('rowheader', { name: 'Sum' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show all' })).toBeNull();
  });

  it('dims and strikes through an excluded column and row, also on the totals', async () => {
    const user = userEvent.setup();
    render(<Harness legend={false} />);
    await user.click(screen.getByRole('button', { name: 'Estimated' }));
    expect(screen.getByRole('button', { name: 'Estimated' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'Estimated' })).toHaveClass('line-through');
    expect(screen.getByRole('cell', { name: '2' })).toHaveClass('line-through', 'opacity-50');
    expect(screen.getByRole('cell', { name: '1' })).not.toHaveClass('line-through');
    expect(screen.getByRole('cell', { name: '3' })).not.toHaveClass('line-through');

    await user.click(screen.getByRole('button', { name: 'Feb' }));
    expect(screen.getByRole('button', { name: 'Feb' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('cell', { name: '9' })).toHaveClass('line-through');
    expect(screen.getByRole('cell', { name: '4' })).toHaveClass('line-through');
    expect(screen.getByTestId('state')).toHaveTextContent('estimated,feb');

    await user.click(screen.getByRole('button', { name: 'Show all' }));
    expect(screen.getByTestId('state')).toBeEmptyDOMElement();
    expect(screen.getByRole('cell', { name: '9' })).not.toHaveClass('line-through');
  });

  it('shares its state with the legend', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(within(screen.getByRole('table')).getByRole('button', { name: 'Declared' }));
    for (const button of screen.getAllByRole('button', { name: 'Declared' })) expect(button).toHaveAttribute('aria-pressed', 'false');
    await user.click(within(screen.getByRole('list', { name: 'Legend' })).getByRole('button', { name: 'Declared' }));
    for (const button of screen.getAllByRole('button', { name: 'Declared' })) expect(button).toHaveAttribute('aria-pressed', 'true');
  });

  it('reports an empty selection once every series is excluded', async () => {
    const user = userEvent.setup();
    render(<Harness legend={false} />);
    await user.click(screen.getByRole('button', { name: 'Declared' }));
    await user.click(screen.getByRole('button', { name: 'Estimated' }));
    expect(screen.getByTestId('empty')).toHaveTextContent('true');
  });

  it('sits in a "Show data table" disclosure with extra content', () => {
    render(<Harness legend={false} table={false} extra />);
    expect(screen.getByText('Show data table')).toBeInTheDocument();
    expect(screen.getByRole('table', { hidden: true, name: 'Numbers in details' })).toBeInTheDocument();
    expect(screen.getByText('More')).toBeInTheDocument();
  });
});

describe('selection notes', () => {
  it('SelectionNote is plain text', () => {
    render(<SelectionNote className="mb-2" />);
    expect(screen.getByText('Chart shows the current selection')).toHaveClass('mb-2');
  });

  it('NothingSelected offers to show everything again', async () => {
    const user = userEvent.setup();
    const onShowAll = vi.fn();
    render(<NothingSelected onShowAll={onShowAll} />);
    expect(screen.getByTestId('nothing-selected')).toHaveTextContent('Nothing selected: show all');
    await user.click(screen.getByRole('button', { name: 'show all' }));
    expect(onShowAll).toHaveBeenCalledOnce();
  });
});

describe('SelectableTable styling options', () => {
  function Styled() {
    const selection = useSeriesSelection(['declared'], ['jan', 'feb']);
    const rows: SelectableRow[] = [
      { id: 'jan', header: 'Jan', cells: ['1'], current: true, note: <span>Target</span> },
      { id: 'feb', header: 'Feb', cells: ['2'] },
    ];
    return <SelectableTable caption="Styled" rowHeader="Month" columns={[{ key: 'declared', label: 'Declared' }]} rows={rows} selection={selection} tableClassName="w-full min-w-[30rem] text-sm" headClassName="sticky top-0" />;
  }

  it('marks the current row, shows a note outside the toggle and applies the table and head classes', () => {
    render(<Styled />);
    const table = screen.getByRole('table', { name: 'Styled' });
    expect(table).toHaveClass('min-w-[30rem]');
    expect(table).not.toHaveClass('text-xs');
    expect(table.querySelector('thead')).toHaveClass('sticky');
    const [jan, feb] = within(table).getAllByRole('row').slice(1);
    expect(jan).toHaveAttribute('aria-current', 'true');
    expect(feb).not.toHaveAttribute('aria-current');
    expect(within(jan!).getByText('Target')).toBeInTheDocument();
    expect(within(jan!).getByRole('button', { name: 'Jan' })).toBeInTheDocument();
  });
});
