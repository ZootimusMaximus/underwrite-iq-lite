// api/debug.js
const fs = require("fs");
const path = require("path");

module.exports = async (req, res) => {
  try {
    const cwd = process.cwd();
    const dirs = fs.readdirSync(cwd, { withFileTypes: true })
      .map(d => (d.isDirectory() ? `[D] ${d.name}` : `[F] ${d.name}`));
    res.status(200).json({
      cwd,
      contents: dirs,
      env: process.env.VERCEL_ENV,
      nodeVersion: process.version
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
