console.log("VuliTab thing loaded");

let timeSpent = 0;

document.getElementById("startBtn").addEventListener("click", function() {
  console.log("button clicked");
  
  setInterval(() => {
    timeSpent++;
    document.getElementById("timer").textContent = timeSpent;
    console.log("The time spent: " + timeSpent + " long seconds");
  }, 1000);
});

console.log("it started...");
