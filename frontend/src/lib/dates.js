export function dayKey(date) {
  const value = new Date(date);
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
}

export function timeLabel(date) {
  return new Intl.DateTimeFormat('en', { hour: 'numeric', minute: '2-digit' }).format(new Date(date));
}

export function dateLabel(date, options = {}) {
  return new Intl.DateTimeFormat('en', { weekday: 'long', month: 'long', day: 'numeric', ...options }).format(new Date(date));
}

export function duration(slot) {
  return Math.round((new Date(slot.end) - new Date(slot.start)) / 60000);
}