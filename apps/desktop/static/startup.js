const query = new URLSearchParams(window.location.search);
document.getElementById("reason").textContent = query.get("reason") ?? "";
document.getElementById("directory").textContent = query.get("dataDirectory") ?? "未选择";
