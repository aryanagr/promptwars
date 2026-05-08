# TravelAI - Travel Planning & Experience Engine

AI-powered travel itinerary generator built for hackathon prototyping with Google Gemini and Google Maps.

## Features
- Generate day-wise itinerary using Gemini
- Budget-aware recommendations
- Interest-based activity planning
- Interactive Google Map with activity markers
- Day tabs, timeline cards, and travel tips UI

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
Create a `.env` file in the project root:

```env
GEMINI_API_KEY=your_gemini_api_key
GOOGLE_MAPS_API_KEY=your_google_maps_api_key
PORT=3000
```

## Run Locally
```bash
npm install
npm run dev
```

Open: `http://localhost:3000`

## API Endpoints
- `GET /api/maps-key` - returns Google Maps API key to frontend
- `POST /api/generate-itinerary` - generates itinerary from trip inputs

### Sample Request (`/api/generate-itinerary`)
```json
{
  "destination": "Tokyo, Japan",
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
