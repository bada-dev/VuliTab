console.log("VuliTab script page: " + document.title);

document.addEventListener("click", function() {
  console.log("activity seen!! They clicked!!");
});

document.addEventListener("keypress", function() {
  console.log("They typed something!!!11!1");
});

console.log("Current URL: " + window.location.href);
console.log("Page title: " + document.title);

// Basic page monitoring
setInterval(() => {
  console.log("Page still active: " + new Date().toLocaleTimeString());
}, 30000);

console.log("Content script initialized correctly");
