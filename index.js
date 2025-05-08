// ai-receptionist-backend/index.js
require('dotenv').config();
const express    = require('express');
const axios      = require('axios');
const bodyParser = require('body-parser');
const fs         = require('fs');
const twilioLib  = require('twilio');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(express.json());

// Env vars
const {
  BLAND_API_KEY,
  BASE_URL,
  GHL_API_KEY,
  GHL_CALENDAR_ID,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
  GHL_TYPE_MICRONEEDLING_ID,
  GHL_TYPE_FACIAL_ID,
  GHL_TYPE_BODYCONTOURING_ID,
  GHL_TYPE_PRP_INJECTIONS_ID,
  GHL_TYPE_LASER_HAIR_REMOVAL_ID
} = process.env;

// Map service name → calendarId (use the IDs you gave me)
const SERVICE_CAL_IDS = {
  "Microneedling":        "CVV5l5hW8oQj9fCvJRQ0",
  "Hydrafacial":          "I9kLB4y6IA6gjSRhoPkE",
  "IPL Acne Treatments":  "LsUJFSftNp3F7WPgX4mZ",
  "Press Files":          "Xo5vCcfx6bWIVykhPbsH",
  "Body Contouring":      "atRqPW5SeTiOXwDx8VZx",
  "PRP Injections":       "hm9zPDrD0kh86uVaZDwW",
  "Laser Hair Removal":   "nddmesx61WaFpfrQR3ut",
  "Fillers":              "xdyndm4rMsTvh48CLRjd",
  "Body Multi Shape":     "fcs6WN0rroebbG97bitr",
  "Laser Treatments":     "ztEI8IyOTmJL7uFzRgCu"
};
// --- helper converts "10:00 AM" → "10:00"
function to24h(time12h) {
  const [t, mod] = time12h.split(' ');
  let [h, m] = t.split(':').map(Number);
  if (mod === 'PM' && h !== 12) h += 12;
  if (mod === 'AM' && h === 12) h = 0;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// 1) Booking → create GHL appointment
app.post('/check-and-book', async (req, res) => {
  try {
    let { name, phone, date, time, service } = req.body;
    if (!service) return res.status(400).json({ status:'fail', message:'Missing service.' });

    service = service.trim();
    const calendarId = SERVICE_CAL_IDS[service];
    if (!calendarId) return res.status(400).json({ status:'fail', message:`Unknown service: ${service}` });

    // Normalize & validate
    if (Array.isArray(date)) date = date.join('');
    if (Array.isArray(time)) time = time.join('');
    date = date.trim(); time = time.trim();
    const dateRe = /^\d{4}-\d{2}-\d{2}$/,
          timeRe = /^([1-9]|1[0-2]):[0-5][0-9] (AM|PM)$/;
    if (!name||!phone||!date||!time)
      return res.status(400).json({ status:'fail', message:'Missing fields.' });
    if (!dateRe.test(date))
      return res.status(400).json({ status:'fail', message:'Date must be YYYY-MM-DD' });
    if (!timeRe.test(time))
      return res.status(400).json({ status:'fail', message:'Time must be H:MM AM/PM' });

    // Build ISO slot
    const [h24,min] = to24h(time).split(':');
    const isoSlot   = `${date}T${h24}:${min}:00-05:00`;

    // Fetch available slots for this service’s calendar
    const startOfDay = new Date(`${date}T00:00:00-05:00`).getTime();
    const endOfDay   = new Date(`${date}T23:59:59-05:00`).getTime();
    const slotsRes = await axios.get(
      'https://rest.gohighlevel.com/v1/appointments/slots',
      {
        headers:{ Authorization:`Bearer ${GHL_API_KEY}` },
        params:{ calendarId, startDate:startOfDay, endDate:endOfDay }
      }
    );
    const daySlots = slotsRes.data[date]?.slots || [];
    if (!daySlots.includes(isoSlot)) {
      return res.status(409).json({ status:'fail', message:'Selected time slot unavailable' });
    }

   // Build startTime / endTime (30-minute default)
const startISO = isoSlot;
const endISO   = new Date(new Date(isoSlot).getTime() + 30*60*1000)
                   .toISOString().replace('.000Z', '-05:00');

// Build booking payload for a stand-alone calendar
const bookPayload = {
  calendarId:           calendarId,
  meetingLocationType:  "custom",
  meetingLocationId:    "default",
  appointmentStatus:    "new",
  name,
  phone,
  startTime:            startISO,
  endTime:              endISO,
  ignoreFreeSlotValidation: false
};


    // 1a) Create the appointment
    const createRes = await axios.post(
      'https://rest.gohighlevel.com/v1/appointments/',
      bookPayload,
      { headers:{ Authorization:`Bearer ${GHL_API_KEY}`, 'Content-Type':'application/json' } }
    );
    const apptId = createRes.data.id;
    console.log('Created appointment:', createRes.data);

    // 1b) Immediately flip to “new”
    await axios.put(
      `https://rest.gohighlevel.com/v1/appointments/${apptId}/status`,
      { status:'new' },
      { headers:{ Authorization:`Bearer ${GHL_API_KEY}`, 'Content-Type':'application/json' } }
    );

    res.json({ status:'success', message:'Appointment booked.' });
  } catch (err) {
    console.error('Booking error:', err.response?.data || err);
    res.status(500).json({ status:'error', message:'Booking failed.' });
  }
});


// 2) Send reminders → Bland calls
app.post('/send-reminders', async (req, res) => {
  const hr = new Date().getHours();
  if (hr < 9 || hr >= 18) return res.status(429).send('Outside call window');

  try {
    const { startMs, endMs } = getTomorrowRange();

    // fetch appointments for every service-specific calendar
    const allAppts = [];
    for (const calId of Object.values(SERVICE_CAL_IDS)) {
      const listRes = await axios.get(
        'https://rest.gohighlevel.com/v1/appointments/',
        {
          headers: { Authorization: `Bearer ${GHL_API_KEY}` },
          params:  { startDate: startMs, endDate: endMs, calendarId: calId, includeAll: true }
        }
      );
      allAppts.push(...(listRes.data.appointments || []));
    }

    for (const a of allAppts) {
      if (!['new', 'booked', 'confirmed'].includes(a.status)) continue;
      const phone = a.contact?.phone || a.phone;
      if (!phone) continue;

      const when = new Date(a.startTime)
                     .toLocaleTimeString('en-US', { hour: 'numeric', minute: 'numeric', hour12: true });
      const task = `Hi ${a.title || 'patient'}, this is Mia confirming your ${a.title} tomorrow at ${when}. Say "yes" to confirm, "no" to cancel, or "reschedule."`;

      await axios.post(
        'https://api.bland.ai/v1/calls',
        {
          phone_number:    phone,
          voice:           'June',
          task,
          callback_url:    `${BASE_URL}/handle-confirmation?appointmentId=${a.id}`,
          status_callback: `${BASE_URL}/call-status`
        },
        { headers: { Authorization: `Bearer ${BLAND_API_KEY}` } }
      );

      fs.appendFileSync('call-log.json',
        JSON.stringify({ ts: new Date().toISOString(), event: 'call-sent', phone }) + '\n');
    }

    res.send('Outbound calls scheduled.');
  } catch (err) {
    console.error('Reminder error:', err.response?.data || err);
    res.status(500).send('Failed to send reminders');
  }
});
// 3) Handle confirmation replies → patch by appointmentId
app.post('/handle-confirmation', async (req, res) => {
  try {
    const apptId = req.query.appointmentId;
    if (!apptId) return res.status(400).send('Missing appointmentId');
    const confirmation = (req.body.confirmation||'').trim().toLowerCase();
    const newStatus = confirmation==='yes' ? 'confirmed' : 'cancelled';
    await axios.put(
      `https://rest.gohighlevel.com/v1/appointments/${apptId}/status`,
      { status: newStatus },
      { headers:{ Authorization:`Bearer ${GHL_API_KEY}`, 'Content-Type':'application/json'} }
    );
    return res.sendStatus(200);
  } catch (err) {
    console.error('Confirmation handling error:', err.response?.data||err);
    res.status(500).send('Confirmation handling failed');
  }
});

// 4) Call status webhook → SMS fallback
app.post('/call-status', async (req, res) => {
  const { status, phone_number } = req.body;
  try {
    if (['no-answer','busy'].includes(status)) {
      await twilioClient.messages.create({
        from: TWILIO_PHONE_NUMBER,
        to:   phone_number,
        body:'We tried calling to confirm your appointment tomorrow. Reply YES, NO, or RESCHEDULE.'
      });
    }
    res.sendStatus(200);
  } catch (err) {
    console.error('Call-status error:', err);
    res.status(500).send('Call status processing failed');
  }
});

// Start server
const PORT = process.env.PORT||3000;
app.listen(PORT,()=>console.log(`Server running on port ${PORT}`));
