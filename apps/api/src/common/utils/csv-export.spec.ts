import { toCSV } from './csv-export';

describe('CSV Export', () => {
  it('should generate header and rows', () => {
    const rows = [
      { name: 'PLA Red', type: 'PLA', cost: 0.025 },
      { name: 'PETG Blue', type: 'PETG', cost: 0.030 },
    ];
    const csv = toCSV(rows);
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe('name,type,cost');
    expect(lines[1]).toBe('PLA Red,PLA,0.025');
    expect(lines[2]).toBe('PETG Blue,PETG,0.03');
  });

  it('should use custom column labels', () => {
    const rows = [{ id: '1', val: 'hello' }];
    const csv = toCSV(rows, [
      { key: 'id', label: 'ID' },
      { key: 'val', label: 'Value' },
    ]);
    expect(csv.split('\r\n')[0]).toBe('ID,Value');
  });

  it('should handle null and undefined values', () => {
    const rows = [{ a: null, b: undefined, c: '' }];
    const csv = toCSV(rows);
    expect(csv.split('\r\n')[1]).toBe(',,');
  });

  it('should escape commas and quotes in values', () => {
    const rows = [{ name: 'PLA, Red', note: 'said "hello"' }];
    const csv = toCSV(rows);
    const lines = csv.split('\r\n');
    expect(lines[1]).toBe('"PLA, Red","said ""hello"""');
  });

  it('should prevent formula injection with = prefix', () => {
    const rows = [{ formula: '=CMD("calc")' }];
    const csv = toCSV(rows);
    expect(csv.split('\r\n')[1]).toContain("'=CMD");
  });

  it('should prevent formula injection with + prefix', () => {
    const rows = [{ formula: '+1+2' }];
    const csv = toCSV(rows);
    expect(csv.split('\r\n')[1]).toBe("'+1+2");
  });

  it('should prevent formula injection with - prefix', () => {
    const rows = [{ formula: '-1+2' }];
    const csv = toCSV(rows);
    expect(csv.split('\r\n')[1]).toBe("'-1+2");
  });

  it('should prevent formula injection with @ prefix', () => {
    const rows = [{ formula: '@SUM(A1:A10)' }];
    const csv = toCSV(rows);
    expect(csv.split('\r\n')[1]).toBe("'@SUM(A1:A10)");
  });

  it('should return empty string for empty rows', () => {
    expect(toCSV([])).toBe('');
  });

  it('should handle numeric values', () => {
    const rows = [{ weight: 152.83, count: 0 }];
    const csv = toCSV(rows);
    expect(csv.split('\r\n')[1]).toBe('152.83,0');
  });

  it('should handle boolean values', () => {
    const rows = [{ active: true, deleted: false }];
    const csv = toCSV(rows);
    expect(csv.split('\r\n')[1]).toBe('true,false');
  });
});
