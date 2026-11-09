import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, CalendarDays, ChevronLeft, ChevronRight, Eye, LoaderCircle, LockKeyhole,
  LogOut, Plus, RefreshCw, Search, Trash2, Users, X } from 'lucide-react';
import { request } from './lib/api.js';
import { dateLabel, timeLabel } from './lib/dates.js';

function localDateTime(value) {
  const date = new Date(value);
  const pad = number => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export default function Admin({ slots, onScheduleChanged }) {
  const [checking, setChecking] = useState(true);
  const [enabled, setEnabled] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [password, setPassword] = useState('');
  const [tab, setTab] = useState('bookings');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [email, setEmail] = useState('');
  const [limit, setLimit] = useState('10');
  const [filter, setFilter] = useState(null);
  const [result, setResult] = useState(null);
  const [cursors, setCursors] = useState([null]);
  const [details, setDetails] = useState(null);
  const [cancelTarget, setCancelTarget] = useState(null);
  const [draft, setDraft] = useState([]);
  const [clearSchedule, setClearSchedule] = useState(false);
  const [resetConfirmation, setResetConfirmation] = useState('');
  const dialog = useRef(null);
  const running = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    request('/api/admin/session', { signal: controller.signal }).then(session => {
      setEnabled(session.enabled);
      setAuthenticated(session.authenticated);
    }).catch(failure => {
      if (!controller.signal.aborted) setError(failure.message);
    }).finally(() => { if (!controller.signal.aborted) setChecking(false); });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (cancelTarget) dialog.current?.showModal();
    else dialog.current?.close();
  }, [cancelTarget]);

  function clearPrivateState() {
    setAuthenticated(false);
    setResult(null);
    setFilter(null);
    setDetails(null);
    setCancelTarget(null);
    setDraft([]);
    setResetConfirmation('');
    setEmail('');
    setPassword('');
  }

  async function perform(operation) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try { await operation(); }
    catch (failure) {
      if (failure.status === 401) clearPrivateState();
      setError(failure.retryAfter ? `${failure.message} Try again in ${failure.retryAfter} seconds.` : failure.message);
    } finally { setBusy(false); running.current = false; }
  }

  async function fetchPage(nextFilter, nextCursors) {
    const query = new URLSearchParams(nextFilter);
    const cursor = nextCursors.at(-1);
    if (cursor) query.set('cursor', cursor);
    const page = await request(`/api/bookings?${query}`);
    setResult(page);
    setFilter(nextFilter);
    setCursors(nextCursors);
    setDetails(null);
  }

  function search(event) {
    event.preventDefault();
    perform(() => fetchPage({ email: email.trim().toLowerCase(), limit }, [null]));
  }

  function updateSlot(index, field, value) {
    setDraft(current => current.map((slot, position) => position === index ? { ...slot, [field]: value } : slot));
    setResetConfirmation('');
    setNotice('');
  }

  function reset(event) {
    event.preventDefault();
    if (resetConfirmation !== 'RESET' || (!draft.length && !clearSchedule)) return;
    perform(async () => {
      const replacement = draft.map(slot => ({ id: slot.id.trim(), provider: slot.provider.trim(),
        start: new Date(slot.start).toISOString(), end: new Date(slot.end).toISOString() }));
      if (replacement.some(slot => slot.end <= slot.start)) throw new Error('Every slot must end after its start time.');
      if (new Set(replacement.map(slot => slot.id)).size !== replacement.length) throw new Error('Slot IDs must be unique.');
      await request('/api/reset', { method: 'POST', headers: { 'X-Confirm-Reset': resetConfirmation },
        body: JSON.stringify({ slots: replacement }) });
      setResult(null);
      setFilter(null);
      setDetails(null);
      setResetConfirmation('');
      setClearSchedule(false);
      setNotice(`Schedule replaced with ${replacement.length} slots. All previous bookings were deleted.`);
      await onScheduleChanged();
    });
  }

  if (checking) return <div className="schedule-loading" role="status"><LoaderCircle className="spin" size={20} /> Checking access...</div>;

  if (!authenticated) return <section className="admin-login" aria-labelledby="admin-title">
    <LockKeyhole size={25} /><h2 id="admin-title">Clinic administration</h2>
    {error && <div className="error-message" role="alert">{error}</div>}
    {enabled ? <form onSubmit={event => { event.preventDefault(); perform(async () => {
      await request('/api/admin/login', { method: 'POST', body: JSON.stringify({ password }) });
      setPassword('');
      setAuthenticated(true);
    }); }}>
      <label htmlFor="admin-password">Administrator password</label>
      <input id="admin-password" type="password" autoComplete="current-password" required value={password}
        onChange={event => setPassword(event.target.value)} disabled={busy} />
      <button className="primary-button booking-submit" disabled={busy}>
        {busy ? <LoaderCircle className="spin" size={17} /> : <LockKeyhole size={17} />} Sign in
      </button>
    </form> : <p className="admin-muted">Administration is unavailable.</p>}
  </section>;

  return <section className="admin-workspace" aria-labelledby="admin-title">
    <div className="section-heading"><div><p className="eyebrow">Clinic administration</p><h2 id="admin-title">Manage bookings</h2></div>
      <button className="secondary-button" disabled={busy} onClick={() => perform(async () => {
        await request('/api/admin/session', { method: 'DELETE', body: '{}' });
        clearPrivateState();
      })}><LogOut size={16} /> Sign out</button>
    </div>
    <div className="admin-tabs" role="tablist" aria-label="Administration">
      <button id="bookings-tab" role="tab" aria-controls="bookings-panel" aria-selected={tab === 'bookings'}
        className={`nav-button ${tab === 'bookings' ? 'active' : ''}`} disabled={busy}
        onClick={() => { setTab('bookings'); setError(''); setNotice(''); }}><Users size={16} /> User bookings</button>
      <button id="reset-tab" role="tab" aria-controls="reset-panel" aria-selected={tab === 'reset'}
        className={`nav-button ${tab === 'reset' ? 'active' : ''}`} disabled={busy}
        onClick={() => { setTab('reset'); setError(''); setNotice(''); }}><CalendarDays size={16} /> Schedule reset</button>
    </div>
    {error && <div className="error-message" role="alert">{error}</div>}
    {notice && <div className="admin-notice" role="status">{notice}</div>}
    {tab === 'bookings' ? <div role="tabpanel" id="bookings-panel" aria-labelledby="bookings-tab">
      <form className="booking-search" onSubmit={search}>
        <div><label htmlFor="search-email">Patient email</label><input id="search-email" type="email" required maxLength={254}
          autoComplete="off" value={email} onChange={event => setEmail(event.target.value)} disabled={busy} placeholder="patient@example.com" /></div>
        <div><label htmlFor="page-size">Per page</label><select id="page-size" value={limit} disabled={busy} onChange={event => setLimit(event.target.value)}>
          {[5, 10, 20, 50].map(size => <option key={size} value={size}>{size}</option>)}</select></div>
        <button className="primary-button" disabled={busy}>{busy ? <LoaderCircle className="spin" size={16} /> : <Search size={16} />} Search</button>
      </form>
      {result && <>
        <div className="results-heading"><div><strong>{filter.email}</strong><span>{result.bookings.length} booking{result.bookings.length === 1 ? '' : 's'} on this page</span></div>
          <button className="icon-button" title="Refresh bookings" aria-label="Refresh bookings" disabled={busy}
            onClick={() => perform(() => fetchPage(filter, cursors))}><RefreshCw size={17} /></button></div>
        {result.bookings.length ? <div className="booking-table-scroll"><table className="booking-table">
          <thead><tr><th>Patient / reference</th><th>Appointment</th><th>Status</th><th>Actions</th></tr></thead>
          <tbody>{result.bookings.map(booking => {
            const slot = slots.find(entry => entry.id === booking.slot_id);
            return <tr key={booking.id}><td><strong>{booking.name}</strong><span className="reference">{booking.id}</span></td>
              <td><strong>{slot?.provider || booking.slot_id}</strong><span>{slot ? `${dateLabel(slot.start)} ${timeLabel(slot.start)}` : 'Schedule unavailable'}</span></td>
              <td><span className={`booking-status status-${booking.status}`}>{booking.status}</span></td>
              <td><div className="table-actions"><button className="icon-button" title="View booking" aria-label={`View booking ${booking.id}`} disabled={busy}
                onClick={() => perform(async () => setDetails(await request(`/api/bookings/${encodeURIComponent(booking.id)}`)))}><Eye size={17} /></button>
                {booking.status === 'confirmed' && <button className="icon-button destructive" title="Cancel booking" aria-label={`Cancel booking ${booking.id}`}
                  disabled={busy} onClick={() => setCancelTarget(booking)}><X size={17} /></button>}</div></td></tr>;
          })}</tbody></table></div> : <div className="empty-state"><Users size={28} /><h3>No bookings for this email</h3></div>}
        <div className="pagination" aria-label="Booking pages">
          <button className="secondary-button" disabled={busy || cursors.length === 1} onClick={() => perform(() => fetchPage(filter, cursors.slice(0, -1)))}><ChevronLeft size={16} /> Previous</button>
          <span>Page {cursors.length}</span>
          <button className="secondary-button" disabled={busy || !result.next_cursor} onClick={() => perform(() => fetchPage(filter, [...cursors, result.next_cursor]))}>Next <ChevronRight size={16} /></button>
        </div>
      </>}
      {details && <section className="admin-booking-details" aria-labelledby="booking-details-title">
        <div className="section-heading"><h3 id="booking-details-title">Booking details</h3><button className="icon-button" title="Close details" aria-label="Close booking details" onClick={() => setDetails(null)}><X size={17} /></button></div>
        <dl>{[['Reference', details.id], ['Patient', details.name], ['Email', details.email], ['Slot', details.slot_id],
          ['Status', details.status], ['Created', new Date(details.created_at).toLocaleString()]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
      </section>}
    </div> : <div role="tabpanel" id="reset-panel" aria-labelledby="reset-tab">
      <div className="reset-warning"><AlertTriangle size={22} /><div><strong>Destructive action</strong>
        <p>This permanently deletes all bookings, idempotency records and rate-limit history, and replaces the entire schedule.</p></div></div>
      <form onSubmit={reset}>
        <div className="schedule-tools"><h3>Replacement schedule <span className="admin-muted">({draft.length} slots)</span></h3>
          <button type="button" className="secondary-button" disabled={busy} onClick={() => {
            setDraft(slots.map(slot => ({ id: slot.id, provider: slot.provider, start: localDateTime(slot.start), end: localDateTime(slot.end) })));
            setClearSchedule(false); setResetConfirmation('');
          }}><RefreshCw size={16} /> Load current schedule</button></div>
        <p className="admin-muted">{Intl.DateTimeFormat().resolvedOptions().timeZone.replaceAll('_', ' ')}</p>
        {draft.map((slot, index) => <div className="reset-slot-row" key={index}>
          <div><label htmlFor={`slot-id-${index}`}>Slot ID</label><input id={`slot-id-${index}`} value={slot.id} required disabled={busy} onChange={event => updateSlot(index, 'id', event.target.value)} /></div>
          <div><label htmlFor={`slot-provider-${index}`}>Clinician</label><input id={`slot-provider-${index}`} value={slot.provider} required disabled={busy} onChange={event => updateSlot(index, 'provider', event.target.value)} /></div>
          <div><label htmlFor={`slot-start-${index}`}>Start</label><input id={`slot-start-${index}`} type="datetime-local" step="1" value={slot.start} required disabled={busy} onChange={event => updateSlot(index, 'start', event.target.value)} /></div>
          <div><label htmlFor={`slot-end-${index}`}>End</label><input id={`slot-end-${index}`} type="datetime-local" step="1" value={slot.end} required disabled={busy} onChange={event => updateSlot(index, 'end', event.target.value)} /></div>
          <button type="button" className="icon-button destructive" title="Remove slot" aria-label={`Remove slot ${index + 1}`} disabled={busy}
            onClick={() => { setDraft(current => current.filter((entry, position) => position !== index)); setResetConfirmation(''); }}><Trash2 size={17} /></button>
        </div>)}
        <button type="button" className="secondary-button" disabled={busy} onClick={() => {
          setDraft(current => [...current, { id: '', provider: '', start: '', end: '' }]);
          setClearSchedule(false); setResetConfirmation('');
        }}><Plus size={16} /> Add slot</button>
        {!draft.length && <label className="checkbox-label"><input type="checkbox" checked={clearSchedule} disabled={busy}
          onChange={event => { setClearSchedule(event.target.checked); setResetConfirmation(''); }} /> Clear schedule without replacement slots</label>}
        <div className="reset-confirmation"><div><label htmlFor="reset-confirmation">Type RESET to confirm deletion</label>
          <input id="reset-confirmation" autoComplete="off" value={resetConfirmation} disabled={busy} onChange={event => setResetConfirmation(event.target.value)} /></div>
          <button className="danger-button" disabled={busy || resetConfirmation !== 'RESET' || (!draft.length && !clearSchedule)}>
            {busy ? <LoaderCircle className="spin" size={16} /> : <Trash2 size={16} />} Reset clinic data
          </button></div>
      </form>
    </div>}
    <dialog ref={dialog} className="cancel-dialog" onCancel={() => setCancelTarget(null)}>
      <h3>Cancel this booking?</h3><p>{cancelTarget?.name} / {cancelTarget?.email}</p>
      <div className="dialog-actions"><button className="secondary-button" disabled={busy} onClick={() => setCancelTarget(null)}>Keep booking</button>
        <button className="danger-button" disabled={busy} onClick={() => perform(async () => {
          const target = cancelTarget;
          try { await request(`/api/bookings/${encodeURIComponent(target.id)}`, { method: 'DELETE', body: '{}' }); }
          catch (failure) { if (failure.status !== 409) throw failure; }
          setCancelTarget(null);
          await fetchPage(filter, cursors);
          await onScheduleChanged();
          setNotice('Booking cancelled.');
        })}>{busy && <LoaderCircle className="spin" size={16} />} Cancel booking</button></div>
    </dialog>
  </section>;
}