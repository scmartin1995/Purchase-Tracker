let purchases = JSON.parse(localStorage.getItem('purchases')) || [];
let burnupChart;

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
  updateBurnupChart();
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

function clearPurchases() {
  if (confirm("Are you sure you want to clear all purchases?")) {
    purchases = [];
    localStorage.removeItem('purchases');
    renderPurchases();
  }
}

function updateBurnupChart() {
  const ctx = document.getElementById('burnupChart').getContext('2d');
  // Sort purchases by date
  const sorted = [...purchases].sort((a, b) => new Date(a.date) - new Date(b.date));

  let labels = [];
  let cumulative = 0;
  let data = [];

  sorted.forEach(p => {
    cumulative += parseFloat(p.amount);
    labels.push(p.date);
    data.push(cumulative.toFixed(2));
  });

  if (burnupChart) {
    burnupChart.destroy();
  }

  burnupChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Cumulative Spending',
        data,
        fill: false,
        borderColor: '#0d1b2a',
        backgroundColor: '#1b263b',
        tension: 0.2
      }]
    },
    options: {
      responsive: true,
      plugins: {
        legend: {
          display: true,
          labels: { color: '#0d1b2a' }
        }
      },
      scales: {
        x: { ticks: { color: '#0d1b2a' } },
        y: { ticks: { color: '#0d1b2a' } }
      }
    }
  });
}

renderPurchases();