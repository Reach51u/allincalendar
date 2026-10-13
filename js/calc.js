// 給料計算（iPhone 版の PayCalculator と同じ考え方）

/**
 * 1シフト分。深夜(22:00〜翌5:00)は割増。休憩は通常時間帯から先に差し引く。
 * shift: { start: Date, end: Date, breakMinutes, wage, nightRate, fee }
 */
export function calcShift(shift) {
  const total = Math.max(0, Math.round((shift.end - shift.start) / 60000));
  let night = 0;
  const t = new Date(shift.start);
  for (let i = 0; i < total; i++) {
    const h = t.getHours();
    if (h >= 22 || h < 5) night++;
    t.setMinutes(t.getMinutes() + 1);
  }
  let day = total - night;
  let brk = Math.min(shift.breakMinutes || 0, total);
  const fromDay = Math.min(brk, day);
  day -= fromDay;
  brk -= fromDay;
  night -= brk;

  const wage = shift.wage || 0;
  const pay = (day * wage + night * wage * (shift.nightRate || 1)) / 60;
  return { workMinutes: day + night, nightMinutes: night, wage: Math.floor(pay), transport: shift.fee || 0 };
}

export function calcShifts(shifts) {
  return shifts.map(calcShift).reduce((a, b) => ({
    workMinutes: a.workMinutes + b.workMinutes,
    nightMinutes: a.nightMinutes + b.nightMinutes,
    wage: a.wage + b.wage,
    transport: a.transport + b.transport,
  }), { workMinutes: 0, nightMinutes: 0, wage: 0, transport: 0 });
}

export const total = r => r.wage + r.transport;

/** 締め日で区切った給料期間 [start, end)。closingDay = 0 は月末締め。month は 0 始まり */
export function payPeriod(year, month, closingDay) {
  const closing = (y, m) => {
    const days = new Date(y, m + 1, 0).getDate();
    const d = (closingDay <= 0 || closingDay >= days) ? days : closingDay;
    return new Date(y, m, d);
  };
  const thisClosing = closing(year, month);
  const prev = new Date(year, month - 1, 1);
  const prevClosing = closing(prev.getFullYear(), prev.getMonth());
  const start = new Date(prevClosing); start.setDate(start.getDate() + 1);
  const end = new Date(thisClosing); end.setDate(end.getDate() + 1);
  return { start, end };
}
