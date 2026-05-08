require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

app.get('/api/maps-key', (req, res) => {
  res.json({ key: process.env.GOOGLE_MAPS_API_KEY });
});

app.post('/api/generate-itinerary', async (req, res) => {
  try {
    const { destination, startDate, endDate, budget, travelers, interests } = req.body;

    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

    const prompt = `You are an expert travel planner with deep knowledge of destinations worldwide. Create a detailed, personalized travel itinerary.

TRIP DETAILS:
- Destination: ${destination}
- Start Date: ${startDate}
- End Date: ${endDate}
- Budget: $${budget} USD total
- Number of Travelers: ${travelers}
- Interests: ${interests}

INSTRUCTIONS:
1. Create a day-by-day itinerary with specific places, times, and estimated costs.
2. Include a mix of popular attractions and hidden gems based on the traveler's interests.
3. Provide realistic latitude and longitude coordinates for each place.
4. Keep the total estimated cost within the budget.
5. Include breakfast, lunch, and dinner recommendations each day.
6. Add practical travel tips specific to the destination.

RESPOND IN THIS EXACT JSON FORMAT (no markdown, no code blocks, just raw JSON):
{
  "tripTitle": "Amazing trip title",
  "summary": "2-3 sentence trip overview",
  "totalEstimatedCost": 0,
  "currency": "USD",
  "tips": ["tip1", "tip2", "tip3", "tip4", "tip5"],
  "days": [
    {
      "day": 1,
      "date": "YYYY-MM-DD",
      "theme": "Day theme/title",
      "activities": [
        {
          "time": "09:00 AM",
          "title": "Activity name",
          "description": "Brief description of the activity",
          "location": "Place name",
          "lat": 0.0,
          "lng": 0.0,
          "duration": "2 hours",
          "estimatedCost": 0,
          "category": "sightseeing|food|adventure|culture|shopping|transport|relaxation"
        }
      ]
    }
  ]
}`;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    let text = response.text();

    // Clean up the response - remove markdown code blocks if present
    text = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

    const itinerary = JSON.parse(text);
    res.json({ success: true, itinerary });
  } catch (error) {
    console.error('Error generating itinerary:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to generate itinerary. Please try again.'
    });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Travel Planner running at http://localhost:${PORT}`);
});
