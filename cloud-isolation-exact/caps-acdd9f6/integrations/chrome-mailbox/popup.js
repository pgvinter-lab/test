void refresh();
document.querySelector("#paused").addEventListener("change", async (event) => {
  await chrome.storage.local.set({ paused: event.target.checked });
});

async function refresh() {
  const state = await chrome.storage.local.get(["paused", "lastPollAt", "lastError", "lastCompletedAt", "lastCompletedMessageId"]);
  document.querySelector("#paused").checked = state.paused === true;
  document.querySelector("#poll").textContent = format(state.lastPollAt);
  document.querySelector("#completed").textContent = state.lastCompletedMessageId ? `${state.lastCompletedMessageId}\n${format(state.lastCompletedAt)}` : "None";
  const error = document.querySelector("#error");
  error.textContent = state.lastError || "Ready";
  error.style.color = state.lastError ? "#a11616" : "#27632a";
}

function format(value) {
  return value ? new Date(value).toLocaleString() : "Never";
}
