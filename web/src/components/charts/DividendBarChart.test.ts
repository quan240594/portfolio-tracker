import { fillMonths } from './DividendBarChart';

describe('fillMonths', () => {
  it('fills gaps across year boundaries', () => {
    expect(
      fillMonths([
        { month: '2024-11', received: 1, upcoming: 0 },
        { month: '2025-02', received: 0, upcoming: 2 },
      ]),
    ).toEqual([
      { month: '2024-11', received: 1, upcoming: 0 },
      { month: '2024-12', received: 0, upcoming: 0 },
      { month: '2025-01', received: 0, upcoming: 0 },
      { month: '2025-02', received: 0, upcoming: 2 },
    ]);
  });

  it('handles empty input', () => {
    expect(fillMonths([])).toEqual([]);
  });
});
