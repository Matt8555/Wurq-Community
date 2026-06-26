const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const publicDir = path.join(__dirname, 'public');

// Serve static assets from the public/ folder
app.use(express.static(publicDir));

// Catch-all: serve index.html for any unmatched route (SPA-friendly)
app.get('*', (req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Wurq Community demo listening on port ${PORT}`);
});
