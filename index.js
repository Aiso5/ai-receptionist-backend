// ai-receptionist-backend/index.js
require('dotenv').config();
const express   = require('express');
const axios     = require('axios');
const bodyParser= require('body-parser');
const twilioLib= require('twilio');
const fs        = require('fs');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(express.json());

/////////////////////////////////////////
// ENV
/////////////////////////////////////////
const {
  BLAND_API_KEY,
  BASE_URL,
  GHL_OAUTH_TOKEN,      // Private Integration token
  GHL_LOCATION_ID,      // Location ID from Business Profile
  GHL_ASSIGNED_USER_ID, // Staff User ID
  GHL_API_KEY,          // v1 API key for contacts
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER
} = process.env;

const twilioClient = twilioLib(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

/////////////////////////////////////////
// SERVICE → CALENDAR MAP (for service_booking)
/////////////////////////////////////////
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

/////////////////////////////////////////
// HELPERS
/////////////////////////////////////////
function to24h(t12) {
  const [t,mod]=t12.split(' ');
  let [h,m]=t.split(':').map(Number);
  if(mod==='PM'&&h!==12) h+=12;
  if(mod==='AM'&&h===12) h=0;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
}
function getTomorrowRange() {
  const s=new Date(), e=new Date();
  s.setDate(s.getDate()+1); s.setHours(0,0,0,0);
  e.setDate(s.getDate());    e.setHours(23,59,59,999);
  return { startMs:s.getTime(), endMs:e.getTime() };
}

// v1 contact lookup/create
async function ensureContact(phone,name) {
  // try fetch
  let r = await axios.get(
    'https://public-api.gohighlevel.com/v1/contacts/',
    { headers:{Authorization:`Bearer ${GHL_API_KEY}`}, params:{phone} }
  );
  if(r.data.contacts?.length) return r.data.contacts[0].id;

  // create
  await axios.post(
    'https://public-api.gohighlevel.com/v1/contacts/',
    { phone, name },
    { headers:{Authorization:`Bearer ${GHL_API_KEY}`} }
  );
  // re-fetch
  r = await axios.get(
    'https://public-api.gohighlevel.com/v1/contacts/',
    { headers:{Authorization:`Bearer ${GHL_API_KEY}`}, params:{phone} }
  );
  return r.data.contacts[0].id;
}

/////////////////////////////////////////
// HEALTHCHECK
/////////////////////////////////////////
app.get('/health',(req,res)=>res.send('OK'));

/////////////////////////////////////////
// 1) BOOK WITH v2 API
/////////////////////////////////////////
app.post('/check-and-book', async (req,res) => {
  try {
    let { name, phone, date, time, service } = req.body;
    if (!service) {
      return res.status(400).json({status:'fail',message:'Missing service.'});
    }
    const typeCalId = SERVICE_CAL_IDS[service.trim()];
    if (!typeCalId) {
      return res.status(400).json({status:'fail',message:`Unknown service: ${service}`});
    }

    // normalize
    date = Array.isArray(date)? date.join('') : (date||'').trim();
    time = Array.isArray(time)? time.join('') : (time||'').trim();

    // validate
    const dateRe=/^\d{4}-\d{2}-\d{2}$/, timeRe=/^([1-9]|1[0-2]):[0-5][0-9] (AM|PM)$/;
    if(!name||!phone||!date||!time) {
      return res.status(400).json({status:'fail',message:'Missing fields.'});
    }
    if(!dateRe.test(date)) {
      return res.status(400).json({status:'fail',message:'Date must be YYYY-MM-DD'});
    }
    if(!timeRe.test(time)) {
      return res.status(400).json({status:'fail',message:'Time must be H:MM AM/PM'});
    }

    // build ISO start/end
    const [h24,min]=to24h(time).split(':');
    const startISO=`${date}T${h24}:${min}:00-05:00`;
    const endISO=new Date(new Date(startISO).getTime()+30*60000)
                    .toISOString().replace('.000Z','-05:00');

    // ensure contact
    const contactId = await ensureContact(phone,name);

    // build v2 payload
    const payload = {
      title:                  `${service} – ${name}`,
      meetingLocationType:    "custom",
      meetingLocationId:      "default",
      overrideLocationConfig: true,
      appointmentStatus:      "new",
      assignedUserId:         GHL_ASSIGNED_USER_ID,
      address:                phone,
      ignoreDateRange:        false,
      toNotify:               false,
      ignoreFreeSlotValidation: true,
      calendarId:             typeCalId,
      locationId:             GHL_LOCATION_ID,
      contactId,
      startTime:              startISO,
      endTime:                endISO
    };

    console.log('v2 Create payload:',payload);

    const create = await axios.post(
      'https://services.leadconnectorhq.com/calendars/events/appointments',
      payload,
      {
        headers: {
          Authorization: `Bearer ${GHL_OAUTH_TOKEN}`,
          Version:        '2021-04-15',
          'Content-Type':'application/json'
        }
      }
    );

    console.log('Created v2 appointment:', create.data);
    return res.json({status:'success',id:create.data.id});

  } catch(err) {
    console.error('Booking error:', err.response?.data||err);
    res.status(500).json({status:'error',message:'Booking failed.'});
  }
});

/////////////////////////////////////////
// 2) SEND REMINDERS (unchanged)
/////////////////////////////////////////
app.post('/send-reminders', async (req,res) => {
  const hr=new Date().getHours();
  if(hr<9||hr>=18) return res.status(429).send('Outside call window');
  try {
    const { startMs,endMs } = getTomorrowRange();
    const all = [];
    // fetch from each service calendar
    for(const calId of Object.values(SERVICE_CAL_IDS)) {
      const r = await axios.get(
        'https://services.leadconnectorhq.com/calendars/events/appointments',
        {
          headers:{
            Authorization:`Bearer ${GHL_OAUTH_TOKEN}`,
            Version:'2021-04-15'
          },
          params:{ calendarId:calId, startTime:startMs, endTime:endMs }
        }
      );
      all.push(...(r.data.appointments||[]));
    }

    for(const a of all) {
      if (!['new','confirmed'].includes(a.appointmentStatus)) continue;
      const phone = a.contact?.phone||a.address;
      if (!phone) continue;
      const when = new Date(a.startTime)
                    .toLocaleTimeString('en-US',{hour:'numeric',minute:'numeric',hour12:true});
      const task = `Hi ${a.title} patient, this is Mia confirming your ${a.title} tomorrow at ${when}. Say "yes" to confirm, "no" to cancel, or "reschedule."`;

      await axios.post(
        'https://api.bland.ai/v1/calls',
        {
          phone_number:   phone,
          voice:          'June',
          task,
          callback_url:   `${BASE_URL}/handle-confirmation?appointmentId=${a.id}`,
          status_callback: `${BASE_URL}/call-status`
        },
        { headers:{Authorization:`Bearer ${BLAND_API_KEY}`} }
      );

      fs.appendFileSync('call-log.json',
        JSON.stringify({ts:new Date().toISOString(),event:'call-sent',phone})+'\n'
      );
    }
    res.send('Outbound calls scheduled.');
  } catch(err) {
    console.error('Reminder error:', err.response?.data||err);
    res.status(500).send('Failed to send reminders');
  }
});

/////////////////////////////////////////
// 3) HANDLE CONFIRMATION
/////////////////////////////////////////
app.post('/handle-confirmation', async (req,res) => {
  try {
    const apptId = req.query.appointmentId;
    if(!apptId) return res.status(400).send('Missing appointmentId');
    const resp = (req.body.confirmation||'').trim().toLowerCase();
    const status = resp==='yes'? 'confirmed':'cancelled';
    await axios.put(
      `https://services.leadconnectorhq.com/calendars/events/appointments/${apptId}/status`,
      { status },
      {
        headers:{
          Authorization:`Bearer ${GHL_OAUTH_TOKEN}`,
          Version:'2021-04-15',
          'Content-Type':'application/json'
        }
      }
    );
    res.sendStatus(200);
  } catch(err){
    console.error('Confirmation error:',err.response?.data||err);
    res.status(500).send('Confirmation handling failed');
  }
});

/////////////////////////////////////////
// 4) CALL-STATUS → SMS FALLBACK
/////////////////////////////////////////
app.post('/call-status', async (req,res) => {
  const {status,phone_number} = req.body;
  try {
    if(['no-answer','busy'].includes(status)) {
      await twilioClient.messages.create({
        from:TWILIO_PHONE_NUMBER,
        to:phone_number,
        body:'We tried calling to confirm your appointment tomorrow. Reply YES, NO, or RESCHEDULE.'
      });
    }
    res.sendStatus(200);
  } catch(err){
    console.error('Call-status error:',err);
    res.status(500).send('Call status processing failed');
  }
});

/////////////////////////////////////////
// START
/////////////////////////////////////////
const PORT = process.env.PORT||10000;
app.listen(PORT,()=>console.log(`Server running on port ${PORT}`));
