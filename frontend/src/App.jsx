import { useEffect, useRef, useState } from 'react';
import { ArrowRight, CalendarDays, Check, CheckCircle2, ChevronLeft, ChevronRight, Clock,
  HeartPulse, LoaderCircle, LockKeyhole, RefreshCw, ShieldCheck, Stethoscope, X } from 'lucide-react';
import Admin from './Admin.jsx';
import { ApiError, bookingKey, clearBookingKey, request } from './lib/api.js';
import { dateLabel, dayKey, duration, timeLabel } from './lib/dates.js';

function ErrorMessage({ message }) {
  return message ? <div className="error-message" role="alert">{message}</div> : null;
}

function Confirmation({ confirmation, onNewBooking, onCancel, cancelling, error }) {
  const [cancelPrompt, setCancelPrompt] = useState(false);
  const dialog = useRef(null);
  const { booking, slot } = confirmation;
  const cancelled = booking.status === 'cancelled';
  useEffect(() => {
    if (cancelPrompt) dialog.current?.showModal();
    else dialog.current?.close();
  }, [cancelPrompt]);

  return <section className="confirmation-view" aria-labelledby="confirmation-title">
    <div className={`confirmation-symbol ${cancelled ? 'cancelled' : ''}`}>
      {cancelled ? <CalendarDays size={32} /> : <Check size={32} />}
    </div>
    <p className="eyebrow">{cancelled ? 'Appointment cancelled' : 'Appointment confirmed'}</p>
    <h2 id="confirmation-title">{cancelled ? 'Your appointment is cancelled.' : `You're booked in, ${booking.name?.split(' ')[0] || 'patient'}.`}</h2>
    <div className="confirmation-details">
      <div className="confirmation-date"><CalendarDays size={22} /><div>
        <strong>{slot ? dateLabel(slot.start) : 'Appointment'}</strong>
        <span>{slot ? `${timeLabel(slot.start)} - ${timeLabel(slot.end)}` : 'Schedule unavailable'}</span>
      </div></div>
      <dl>
        <div><dt>Clinician</dt><dd>{slot?.provider || 'Clinic team'}</dd></div>
        <div><dt>Patient</dt><dd>{booking.name}</dd></div>
        <div><dt>Email</dt><dd>{booking.email}</dd></div>
        <div><dt>Booking reference</dt><dd className="reference">{booking.id}</dd></div>
        <div><dt>Status</dt><dd className={cancelled ? 'status-cancelled' : 'status-confirmed'}>{cancelled ? 'Cancelled' : 'Confirmed'}</dd></div>
      </dl>
    </div>
    <ErrorMessage message={error} />
    <div className="confirmation-actions">
      <button className="primary-button" onClick={onNewBooking}><CalendarDays size={17} /> Book another appointment</button>
      {!cancelled && <button className="text-button destructive" onClick={() => setCancelPrompt(true)} disabled={cancelling}>Cancel appointment</button>}
    </div>
    <dialog ref={dialog} className="cancel-dialog" onCancel={() => setCancelPrompt(false)}>
      <button className="icon-button close-dialog" title="Close" aria-label="Close cancellation dialog" onClick={() => setCancelPrompt(false)}><X size={18} /></button>
      <h3>Cancel this appointment?</h3>
      <p>{slot ? `${dateLabel(slot.start)} at ${timeLabel(slot.start)}` : 'Your scheduled clinic appointment'}</p>
      <div className="dialog-actions">
        <button className="secondary-button" onClick={() => setCancelPrompt(false)}>Keep appointment</button>
        <button className="danger-button" disabled={cancelling} onClick={async () => { await onCancel(); setCancelPrompt(false); }}>
          {cancelling ? <LoaderCircle className="spin" size={16} /> : null} Cancel appointment
        </button>
      </div>
    </dialog>
  </section>;
}

export default function App() {
  const [slots, setSlots] = useState([]);
  const [loading, setLoading] = useState(true);
  const [slotsError, setSlotsError] = useState('');
  const [provider, setProvider] = useState('');
  const [day, setDay] = useState('');
  const [selectedId, setSelectedId] = useState(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [bookingError, setBookingError] = useState('');
  const [busy, setBusy] = useState(false);
  const [retryUntil, setRetryUntil] = useState(0);
  const [retrySeconds, setRetrySeconds] = useState(0);
  const [confirmation, setConfirmation] = useState(null);
  const [view, setView] = useState('booking');
  const [cancelBusy, setCancelBusy] = useState(false);
  const [cancelError, setCancelError] = useState('');
  const submitting = useRef(false);
  const dateStrip = useRef(null);

  async function loadSlots(signal) {
    setLoading(true);
    setSlotsError('');
    try {
      const result = await request('/api/slots', { signal });
      setSlots(result.slots);
      setSelectedId(current => result.slots.some(slot => slot.id === current && slot.available) ? current : null);
    } catch (error) {
      if (error.name !== 'AbortError') setSlotsError(error.message);
    } finally { if (!signal?.aborted) setLoading(false); }
  }

  useEffect(() => {
    const controller = new AbortController();
    loadSlots(controller.signal);
    request('/api/confirmation', { signal: controller.signal }).then(result => {
      setConfirmation(result);
      setView(current => current === 'booking' ? 'confirmation' : current);
    }).catch(() => {});
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!retryUntil) return;
    const update = () => {
      const remaining = Math.max(0, Math.ceil((retryUntil - Date.now()) / 1000));
      setRetrySeconds(remaining);
      if (!remaining) setRetryUntil(0);
    };
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [retryUntil]);

  const future = slots.filter(slot => new Date(slot.start).getTime() > Date.now());
  const providers = [...new Set(future.map(slot => slot.provider))].sort();
  const filtered = future.filter(slot => !provider || slot.provider === provider);
  const dates = [...new Map(filtered.map(slot => [dayKey(slot.start), slot.start])).entries()];
  const activeDay = dates.some(([key]) => key === day) ? day : dates[0]?.[0];
  const dailySlots = filtered.filter(slot => dayKey(slot.start) === activeDay);
  const selected = future.find(slot => slot.id === selectedId);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const morning = dailySlots.filter(slot => new Date(slot.start).getHours() < 12);
  const afternoon = dailySlots.filter(slot => new Date(slot.start).getHours() >= 12);

  async function book(event) {
    event.preventDefault();
    if (!selected || submitting.current || retrySeconds > 0) return;
    submitting.current = true;
    setBusy(true);
    setBookingError('');
    const payload = { slot_id: selected.id, name: name.trim(), email: email.trim().toLowerCase() };
    try {
      const key = await bookingKey(payload);
      const booking = await request('/api/bookings', {
        method: 'POST', headers: { 'Idempotency-Key': key }, body: JSON.stringify(payload)
      });
      clearBookingKey();
      setConfirmation({ booking, slot: selected });
      setView('confirmation');
      setSlots(current => current.map(slot => slot.id === selected.id ? { ...slot, available: false } : slot));
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (error) {
      setBookingError(error.message);
      if (error instanceof ApiError && error.status < 500) clearBookingKey();
      if (error.status === 409 || error.status === 400) await loadSlots();
      if (error.status === 429) setRetryUntil(Date.now() + Math.max(1, error.retryAfter) * 1000);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  async function cancel() {
    setCancelBusy(true);
    setCancelError('');
    try {
      await request('/api/confirmation', { method: 'DELETE', body: '{}' });
      setConfirmation(current => ({ ...current, booking: { ...current.booking, status: 'cancelled' } }));
      await loadSlots();
    } catch (error) {
      if (error.status === 409) setConfirmation(current => ({ ...current, booking: { ...current.booking, status: 'cancelled' } }));
      else setCancelError(error.message);
    } finally { setCancelBusy(false); }
  }

  function newBooking() {
    setView('booking');
    setSelectedId(null);
    setBookingError('');
    setCancelError('');
    loadSlots();
  }

  async function refreshAfterAdminChange() {
    await loadSlots();
    try { setConfirmation(await request('/api/confirmation')); }
    catch (error) { if (error.status === 404) setConfirmation(null); }
  }

  function slotGroup(label, entries) {
    if (!entries.length) return null;
    return <div className="slot-group" key={label}>
      <h3>{label} <span>{entries.filter(slot => slot.available).length} available</span></h3>
      <div className="slot-grid">{entries.map(slot => <button key={slot.id} type="button"
        className={`slot-button ${selectedId === slot.id ? 'selected' : ''}`} disabled={!slot.available || busy}
        aria-pressed={selectedId === slot.id} aria-label={`${timeLabel(slot.start)}, ${slot.provider}${slot.available ? '' : ', booked'}`}
        onClick={() => { setSelectedId(slot.id); setBookingError(''); }}>
        <span>{timeLabel(slot.start)}{selectedId === slot.id ? <Check size={14} /> : null}</span>
        <small>{slot.available ? slot.provider : 'Booked'}</small>
      </button>)}</div>
    </div>;
  }

  return <>
    <header className="site-header"><div className="header-inner">
      <a className="wordmark" href="/" aria-label="Cedar Clinic home"><HeartPulse size={27} strokeWidth={1.8} /><span>Cedar<span className="wordmark-light">Clinic</span></span></a>
      <nav aria-label="Appointments"><button className={`nav-button ${view === 'booking' ? 'active' : ''}`} onClick={newBooking}><CalendarDays size={16} /> Book a visit</button>
        {confirmation && <button className={`nav-button ${view === 'confirmation' ? 'active' : ''}`} onClick={() => setView('confirmation')}><CheckCircle2 size={16} /> Your appointment</button>}
        <button className={`nav-button ${view === 'admin' ? 'active' : ''}`} onClick={() => setView('admin')}><LockKeyhole size={16} /> Manage bookings</button>
      </nav>
    </div></header>
    <main className="page-shell">
      <section className="clinic-strip" aria-label="Clinic">
        <div><p className="eyebrow">General practice</p><h1>Cedar Clinic</h1><p className="clinic-subtitle">Care that makes room for you.</p>
          <div className="clinic-facts"><span><Stethoscope size={15} /> In-person appointments</span><span><Clock size={15} /> Scheduled visits</span></div>
        </div>
        <img src="/clinic.jpg" alt="Bright clinic reception and waiting area" width="1200" height="817" />
      </section>
      {view === 'admin' ? <Admin slots={slots} onScheduleChanged={refreshAfterAdminChange} /> : view === 'confirmation' && confirmation ? <Confirmation confirmation={confirmation} onNewBooking={newBooking}
        onCancel={cancel} cancelling={cancelBusy} error={cancelError} /> : <>
        <div className="workflow-heading"><span className="step-mark">01</span><h2>Your next appointment</h2><span className="step-text">Choose a time. Make it yours.</span></div>
        <div className="booking-layout">
          <section className="schedule" aria-labelledby="schedule-title">
            <div className="section-heading"><div><p className="eyebrow">Appointment times</p><h2 id="schedule-title">Find your time</h2></div>
              <button className="icon-button" title="Refresh appointments" aria-label="Refresh appointments" disabled={loading || busy} onClick={() => loadSlots()}><RefreshCw size={18} className={loading ? 'spin' : ''} /></button>
            </div>
            <div className="provider-field"><label htmlFor="provider">Clinician</label><select id="provider" value={provider} disabled={busy || loading}
              onChange={event => { setProvider(event.target.value); setSelectedId(null); setDay(''); }}>
              <option value="">All clinicians</option>{providers.map(value => <option key={value}>{value}</option>)}
            </select></div>
            <ErrorMessage message={slotsError} />
            {loading ? <div className="schedule-loading" role="status"><LoaderCircle size={21} className="spin" /> Finding appointments...</div> : !dates.length ?
              <div className="empty-state"><CalendarDays size={30} /><h3>No upcoming appointments</h3><button className="secondary-button" onClick={() => loadSlots()}><RefreshCw size={16} /> Refresh</button></div> : <>
                <div className="date-navigation"><button className="icon-button" title="Earlier dates" aria-label="Earlier dates" onClick={() => dateStrip.current?.scrollBy({ left: -260, behavior: 'smooth' })}><ChevronLeft size={18} /></button>
                  <div className="date-strip" ref={dateStrip} aria-label="Appointment dates">{dates.map(([key, date]) => <button type="button" key={key}
                    className={`date-button ${activeDay === key ? 'selected' : ''}`} disabled={busy} aria-pressed={activeDay === key} onClick={() => { setDay(key); setSelectedId(null); }}>
                    <span>{new Intl.DateTimeFormat('en', { weekday: 'short' }).format(new Date(date))}</span><strong>{new Date(date).getDate()}</strong>
                    <small>{new Intl.DateTimeFormat('en', { month: 'short' }).format(new Date(date))}</small>
                  </button>)}</div>
                  <button className="icon-button" title="Later dates" aria-label="Later dates" onClick={() => dateStrip.current?.scrollBy({ left: 260, behavior: 'smooth' })}><ChevronRight size={18} /></button>
                </div>
                <div className="day-heading"><strong>{dateLabel(dailySlots[0].start, { weekday: 'long', month: 'short' })}</strong><span>{timezone.replaceAll('_', ' ')}</span></div>
                {slotGroup('Morning', morning)}{slotGroup('Afternoon', afternoon)}
              </>}
          </section>
          <section className="visit-details" aria-labelledby="details-title">
            <p className="eyebrow">Your visit</p><h2 id="details-title">A few details</h2>
            <div className={`selected-visit ${selected ? 'has-selection' : ''}`} aria-live="polite">
              <CalendarDays size={21} /><div><strong>{selected ? dateLabel(selected.start, { weekday: 'short', month: 'short' }) : 'Appointment time'}</strong>
                <span>{selected ? `${timeLabel(selected.start)} - ${timeLabel(selected.end)}` : 'Not selected'}</span>
                {selected && <small>{selected.provider} <span aria-hidden="true">/</span> {duration(selected)} min</small>}
              </div>
            </div>
            <form onSubmit={book}>
              <label htmlFor="patient-name">Full name</label><input id="patient-name" name="name" autoComplete="name" required value={name} onChange={event => setName(event.target.value)} disabled={busy} placeholder="Your full name" />
              <label htmlFor="patient-email">Email address</label><input id="patient-email" name="email" type="email" autoComplete="email" maxLength={254} required value={email} onChange={event => setEmail(event.target.value)} disabled={busy} placeholder="you@example.com" />
              <ErrorMessage message={bookingError} />
              <button className="primary-button booking-submit" type="submit" disabled={!selected || busy || retrySeconds > 0}>
                {busy ? <><LoaderCircle size={17} className="spin" /> Booking appointment...</> : retrySeconds > 0 ? `Try again in ${retrySeconds}s` : <>Confirm appointment <ArrowRight size={17} /></>}
              </button>
            </form>
            <div className="privacy-note"><ShieldCheck size={17} /><span>Your details stay private.</span></div>
          </section>
        </div>
      </>}
      <footer className="site-footer"><span>Cedar Clinic</span><span>Room for better days.</span></footer>
    </main>
  </>;
}