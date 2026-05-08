# TravelAI - Travel Planning & Experience Engine

AI-powered travel itinerary generator built for hackathon prototyping with Google Gemini and Google Maps.

## Features
- Generate day-wise itinerary using Gemini
- Budget-aware recommendations
- Interest-based activity planning
- Multi-city planning with intermediate stops and day allocation per stop
- Interactive Google Map with activity markers
- Day tabs, timeline cards, and travel tips UI
- Request rate limiting + secure response headers
- Short-lived itinerary caching for repeated requests
- Basic automated tests for city/day planning logic

## Tech Stack
- Node.js + Express
- Google Gemini (`@google/generative-ai`)
- Google Maps JavaScript API
- Vanilla HTML/CSS/JS frontend

## Project Structure
- `server.js` - API server and Gemini integration
- `public/index.html` - main UI
- `public/style.css` - styling
- `public/script.js` - frontend logic and maps rendering

## Environment Variables
Create a `.env` file in the project root (you can copy from `.env.example`):

```bash
cp .env.example .env
```

Then update values:

```env
GEMINI_API_KEY=your_gemini_api_key
GOOGLE_MAPS_API_KEY=your_google_maps_api_key
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your_email@gmail.com
SMTP_PASS=your_app_password
MAIL_FROM=TravelAI <your_email@gmail.com>
CORS_ORIGINS=https://yourdomain.com,https://www.yourdomain.com
API_RATE_LIMIT_WINDOW_MS=60000
API_RATE_LIMIT_MAX=30
ITINERARY_CACHE_TTL_MS=180000
PORT=3000
```

Mail aliases supported: `SMTP_*` or `MAIL_*` or `EMAIL_*`.

## Run Locally
```bash
npm install
npm run dev
```

Open: `http://localhost:3000`

## Run Tests
```bash
npm test
```

## API Endpoints
- `GET /api/maps-key` - returns Google Maps API key to frontend
- `POST /api/generate-itinerary` - generates itinerary from trip inputs

### Sample Request (`/api/generate-itinerary`)
```json
{
  "fromPlace": "Mumbai, India",
  "toPlace": "Jaipur, India",
  "destination": "Jaipur, India",
  "stops": [
    { "city": "Udaipur, India", "days": 1 }
  ],
  "startDate": "2026-05-10",
  "endDate": "2026-05-13",
  "budget": 2000,
  "travelers": 2,
  "interests": "Culture & History, Food & Dining"
}
```

## Notes
- This is currently a single-city planning prototype.
- Generated itineraries are AI outputs and should be validated before real-world booking.

## License
MIT
