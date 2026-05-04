const express = require('express');
const fs      = require('fs');
const path    = require('path');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const { v4: uuid } = require('uuid');
const ical    = require('ical-generator');

const app  = express();
const PORT = process.env.PORT || 3001;
const DIR  = __dirname;
const DATA = path.join(DIR, 'data');
const SECRET = process.env.JWT_SECRET || 'sophie-local-secret-2025';

app.use(express.json());
app.use(express.static(DIR));

// ── Helpers ────────────────────────────────────────────────────────────────
const read  = f => JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'));
const write = (f, d) => fs.writeFileSync(path.join(DATA, f), JSON.stringify(d, null, 2));

function boot() {
  if (!fs.existsSync(DATA)) fs.mkdirSync(DATA, { recursive: true });
  if (!fs.existsSync(path.join(DATA, 'appointments.json'))) write('appointments.json', []);
  if (!fs.existsSync(path.join(DATA, 'patients.json')))     write('patients.json', []);
  if (!fs.existsSync(path.join(DATA, 'config.json'))) {
    write('config.json', {
      adminPassword: bcrypt.hashSync('sophie2025', 10),
      icalToken: uuid(),
      availability: {
        weekly: {
          lundi:    ['09:00','10:00','11:00','14:00','15:00','16:00','17:00'],
          mardi:    ['09:00','10:00','11:00','14:00','15:00','16:00','17:00'],
          mercredi: ['09:00','10:00','11:00','14:00','15:00','16:00','17:00'],
          jeudi:    ['09:00','10:00','11:00','14:00','15:00','16:00','17:00'],
          vendredi: ['09:00','10:00','11:00','14:00','15:00'],
          samedi:   [],
          dimanche: []
        },
        blockedDates: [],
        slotDuration: 60
      }
    });
  }
}
boot();

// ── Auth middleware ────────────────────────────────────────────────────────
function auth(req, res, next) {
  const token = (req.headers.authorization || '').split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Non autorisé' });
  try { req.admin = jwt.verify(token, SECRET); next(); }
  catch { res.status(401).json({ error: 'Session expirée' }); }
}

// ── PUBLIC : Disponibilités ────────────────────────────────────────────────
app.get('/api/availability/:ym', (req, res) => {
  const [y, m]   = req.params.ym.split('-').map(Number);
  const cfg      = read('config.json');
  const appts    = read('appointments.json');
  const { weekly, blockedDates } = cfg.availability;
  const jours    = ['dimanche','lundi','mardi','mercredi','jeudi','vendredi','samedi'];
  const today    = new Date(); today.setHours(0,0,0,0);
  const result   = {};

  for (let d = 1; d <= new Date(y, m, 0).getDate(); d++) {
    const date    = new Date(y, m - 1, d);
    if (date < today) continue;
    const dateStr = `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    if (blockedDates.includes(dateStr)) continue;
    const slots   = weekly[jours[date.getDay()]] || [];
    if (!slots.length) continue;
    const booked  = appts
      .filter(a => a.date === dateStr && ['confirmé','en attente'].includes(a.status))
      .map(a => a.time);
    const free    = slots.filter(s => !booked.includes(s));
    if (free.length) result[dateStr] = free;
  }
  res.json(result);
});

// ── PUBLIC : Réservation ───────────────────────────────────────────────────
app.post('/api/booking', (req, res) => {
  const { date, time, firstName, lastName, email, phone, type, notes } = req.body;
  if (!date || !time || !firstName || !lastName || !email)
    return res.status(400).json({ error: 'Champs obligatoires manquants' });

  const appts    = read('appointments.json');
  const patients = read('patients.json');

  const conflict = appts.find(a =>
    a.date === date && a.time === time && ['confirmé','en attente'].includes(a.status));
  if (conflict) return res.status(409).json({ error: 'Ce créneau vient d\'être réservé, veuillez en choisir un autre.' });

  let patient = patients.find(p => p.email.toLowerCase() === email.toLowerCase());
  if (!patient) {
    patient = { id: uuid(), firstName, lastName, email, phone: phone||'', notes: '', createdAt: new Date().toISOString() };
    patients.push(patient);
  } else {
    Object.assign(patient, { firstName, lastName, phone: phone||patient.phone });
  }
  write('patients.json', patients);

  const appt = {
    id: uuid(), patientId: patient.id,
    date, time, firstName, lastName, email, phone: phone||'',
    type: type||'Consultation sophrologie', notes: notes||'',
    status: 'en attente', createdAt: new Date().toISOString()
  };
  appts.push(appt);
  write('appointments.json', appts);
  res.json({ success: true, id: appt.id });
});

// ── PUBLIC : Feed iCal ─────────────────────────────────────────────────────
app.get('/calendar.ics', (req, res) => {
  const cfg   = read('config.json');
  const token = req.query.token;
  if (token !== cfg.icalToken) return res.status(403).send('Token invalide');

  const appts = read('appointments.json').filter(a => a.status === 'confirmé');
  const cal   = ical.default({ name: 'Sophie Pellegrin · Consultations' });

  appts.forEach(a => {
    const [y,mo,d] = a.date.split('-').map(Number);
    const [h,mn]   = a.time.split(':').map(Number);
    const dur      = read('config.json').availability.slotDuration || 60;
    const start    = new Date(y, mo-1, d, h, mn);
    const end      = new Date(start.getTime() + dur*60*1000);
    cal.createEvent({
      id: a.id, start, end,
      summary: `${a.type} — ${a.firstName} ${a.lastName}`,
      description: `${a.firstName} ${a.lastName}\n${a.phone}\n${a.email}${a.notes?'\n'+a.notes:''}`,
      location: 'Cabinet Sophie Pellegrin, Mougins (06)'
    });
  });

  res.set('Content-Type', 'text/calendar; charset=utf-8');
  res.set('Content-Disposition', 'inline; filename="consultations.ics"');
  res.send(cal.toString());
});

// ── ADMIN : Login ──────────────────────────────────────────────────────────
app.post('/admin/login', (req, res) => {
  const cfg = read('config.json');
  if (!bcrypt.compareSync(req.body.password||'', cfg.adminPassword))
    return res.status(401).json({ error: 'Mot de passe incorrect' });
  res.json({ token: jwt.sign({ admin: true }, SECRET, { expiresIn: '12h' }) });
});

// ── ADMIN : Stats ──────────────────────────────────────────────────────────
app.get('/admin/api/stats', auth, (req, res) => {
  const appts    = read('appointments.json');
  const patients = read('patients.json');
  const today    = new Date().toISOString().split('T')[0];
  const inWeek   = new Date(Date.now() + 7*86400*1000).toISOString().split('T')[0];
  res.json({
    totalPatients:    patients.length,
    todayAppts:       appts.filter(a => a.date === today && a.status === 'confirmé').length,
    pendingRequests:  appts.filter(a => a.status === 'en attente').length,
    weekAppts:        appts.filter(a => a.date >= today && a.date <= inWeek && a.status === 'confirmé').length
  });
});

// ── ADMIN : Rendez-vous ────────────────────────────────────────────────────
app.get('/admin/api/appointments', auth, (req, res) => {
  const appts = read('appointments.json');
  appts.sort((a,b) => a.date.localeCompare(b.date)||a.time.localeCompare(b.time));
  res.json(appts);
});

app.put('/admin/api/appointments/:id', auth, (req, res) => {
  const appts = read('appointments.json');
  const i = appts.findIndex(a => a.id === req.params.id);
  if (i === -1) return res.status(404).json({ error: 'Non trouvé' });
  appts[i] = { ...appts[i], ...req.body };
  write('appointments.json', appts);
  res.json(appts[i]);
});

app.delete('/admin/api/appointments/:id', auth, (req, res) => {
  const appts = read('appointments.json').filter(a => a.id !== req.params.id);
  write('appointments.json', appts);
  res.json({ success: true });
});

// ── ADMIN : Patients ───────────────────────────────────────────────────────
app.get('/admin/api/patients', auth, (req, res) => {
  const patients = read('patients.json');
  const appts    = read('appointments.json');
  res.json(patients.map(p => ({
    ...p,
    totalAppts: appts.filter(a => a.patientId === p.id).length,
    lastVisit:  appts.filter(a => a.patientId === p.id && a.status === 'confirmé')
                     .sort((a,b) => b.date.localeCompare(a.date))[0]?.date || null,
    history:    appts.filter(a => a.patientId === p.id)
                     .sort((a,b) => b.date.localeCompare(a.date))
  })));
});

app.put('/admin/api/patients/:id', auth, (req, res) => {
  const patients = read('patients.json');
  const i = patients.findIndex(p => p.id === req.params.id);
  if (i === -1) return res.status(404).json({ error: 'Non trouvé' });
  patients[i] = { ...patients[i], ...req.body };
  write('patients.json', patients);
  res.json(patients[i]);
});

// ── ADMIN : Disponibilités ─────────────────────────────────────────────────
app.get('/admin/api/availability', auth, (req, res) => res.json(read('config.json').availability));

app.put('/admin/api/availability', auth, (req, res) => {
  const cfg = read('config.json');
  cfg.availability = { ...cfg.availability, ...req.body };
  write('config.json', cfg);
  res.json(cfg.availability);
});

// ── ADMIN : iCal token & mot de passe ─────────────────────────────────────
app.get('/admin/api/ical-url', auth, (req, res) => {
  const cfg = read('config.json');
  const host = `${req.protocol}://${req.get('host')}`;
  res.json({ url: `${host}/calendar.ics?token=${cfg.icalToken}` });
});

app.post('/admin/api/change-password', auth, (req, res) => {
  const { newPassword } = req.body;
  if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: 'Mot de passe trop court (6 caractères min.)' });
  const cfg = read('config.json');
  cfg.adminPassword = bcrypt.hashSync(newPassword, 10);
  write('config.json', cfg);
  res.json({ success: true });
});

// ── Start ──────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  const cfg = read('config.json');
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║   Sophie Pellegrin · Sophrologue                ║');
  console.log('╠══════════════════════════════════════════════════╣');
  console.log(`║  Site       →  http://localhost:${PORT}           ║`);
  console.log(`║  Réserver   →  http://localhost:${PORT}/booking.html ║`);
  console.log(`║  Admin      →  http://localhost:${PORT}/admin.html  ║`);
  console.log(`║  iCal feed  →  /calendar.ics?token=...          ║`);
  console.log('╠══════════════════════════════════════════════════╣');
  console.log(`║  Mot de passe admin : sophie2025                ║`);
  console.log('╚══════════════════════════════════════════════════╝\n');
});
