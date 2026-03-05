const functions = require('@google-cloud/functions-framework');
const { Pool } = require('pg');

// 1. Database Connection Pool Setup
const pool = new Pool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  max: 10, 
});

functions.http('submitResponse', async (req, res) => {
  // 2. CORS Handling (Crucial for Flutter Web)
  res.set('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') {
    res.set('Access-Control-Allow-Methods', 'POST');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.status(204).send('');
    return;
  }

  if (req.method !== 'POST') {
    return res.status(405).send('Method Not Allowed');
  }

  // Extract the top-level objects from the Flutter payload
  const { metadata, responses } = req.body;

  // 3. Payload Validation
  if (!metadata || !responses) {
    return res.status(400).send({ error: 'Invalid payload. "metadata" and "responses" objects are required.' });
  }

  const { response_id, org_id, user_id, timestamp, user_department } = metadata;

  if (!response_id || !org_id || !user_id) {
    return res.status(400).send({ error: 'Missing required metadata fields.' });
  }

  // Flutter sends 'responses' as an object (Map), not an array.
  // We get the keys (e.g., ["q1", "q2", ..., "Q15", ..., "q27"])
  const responseKeys = Object.keys(responses);
  
  // Ensure exactly 27 variables are submitted according to your JSON
  if (responseKeys.length !== 27) {
    return res.status(400).send({ error: `Submission must contain exactly 27 responses. Received ${responseKeys.length}.` });
  }

  // 4. Data Integrity Check
  for (const [questionId, ans] of Object.entries(responses)) {
    if (!Number.isInteger(ans.importance) || ans.importance < 1 || ans.importance > 5 ||
        !Number.isInteger(ans.performance) || ans.performance < 1 || ans.performance > 5) {
      return res.status(400).send({ 
        error: `Invalid score for ${questionId}. Ratings must be integers between 1 and 5.` 
      });
    }
  }

  // 5. Database Insertion (Using Transactions)
  const client = await pool.connect();

  try {
    await client.query('BEGIN'); 

    // Insert Metadata into Submissions Table
    const submissionQuery = `
      INSERT INTO submissions (response_id, org_id, user_id, user_department, submitted_at)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING response_id;
    `;
    // We use the timestamp provided by Flutter
    await client.query(submissionQuery, [response_id, org_id, user_id, user_department, timestamp]);

    // Insert Individual Responses
    const responseQuery = `
      INSERT INTO responses (response_id, variable_id, importance_score, performance_score, comment)
      VALUES ($1, $2, $3, $4, $5);
    `;

    // Iterate through the Map entries to insert each answer
    for (const [questionId, ans] of Object.entries(responses)) {
      await client.query(responseQuery, [
        response_id,
        questionId,       // e.g., "q1", "q2", "Q15"
        ans.importance,   // Mapped directly from the Dart 'importance' field
        ans.performance,  // Mapped directly from the Dart 'performance' field
        ans.text          // Mapped directly from the Dart 'text' field
      ]);
    }

    await client.query('COMMIT'); 
    res.status(200).send({ message: 'Survey securely submitted and processed.' });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Database transaction error:', error);
    res.status(500).send({ error: 'Internal Server Error while writing to database.' });
  } finally {
    client.release();
  }
});