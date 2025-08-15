let purchases = JSON.parse(localStorage.getItem('purchases')) || [];

function renderPurchases() {
  const list = document.getElementById('purchaseList');
  const totalDisplay = document.getElementById('totalSpent');
  list.innerHTML = '';
  let total = 0;
  purchases.forEach((p, index) => {
    total += parseFloat(p.amount);
    const div = document.createElement('div');
    div.className = 'purchase-item';
    div.innerHTML = `
      <span>${p.date} - ${p.name}</span>
      <span>$${parseFloat(p.amount).toFixed(2)}</span>
      <button onclick="deletePurchase(${index})">❌</button>
    `;
    list.appendChild(div);
  });
  totalDisplay.textContent = `Total: $${total.toFixed(2)}`;
  localStorage.setItem('purchases', JSON.stringify(purchases));
}

function addPurchase() {
  const name = document.getElementById('itemName').value.trim();
  const amount = document.getElementById('itemAmount').value;
  const date = document.getElementById('itemDate').value;
  if (!name || !amount || !date) {
    alert('Please fill out all fields');
    return;
  }
  purchases.push({ name, amount, date });
  document.getElementById('itemName').value = '';
  document.getElementById('itemAmount').value = '';
  document.getElementById('itemDate').value = '';
  renderPurchases();
}

function deletePurchase(index) {
  purchases.splice(index, 1);
  renderPurchases();
}

renderPurchases();