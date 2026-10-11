const fs = require("fs");
const s = fs.readFileSync("C:/Users/lepri/urgad-backend/node_modules/sql.js/dist/sql-wasm-browser.js", "utf8");
const i = s.indexOf("run:function");
console.log("i", i);
console.log(s.slice(i, i + 800));
