import express from 'express';
const app = express();
const port = process.env.PORT || 10000; 

app.get('/', (req, res) => {
  res.send('Automation bot is running. Cron jobs are active.');
});

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});

