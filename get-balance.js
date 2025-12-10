const fetch = (...args) => import('node-fetch').then(mod => mod.default(...args));

async function getBalance(address) {
  const url = `https://mempool.space/testnet4/api/address/${address}`;
  const response = await fetch(url);
  const data = await response.json();
  // Вычисляем баланс в сатоши: разница между суммой всех поступивших средств (`funded_txo_sum`) 
  // и суммой всех потраченных средств (`spent_txo_sum`) в статистике цепочки (`chain_stats`).
  // Сатоши — минимальная единица биткоина: 1 сатоши = 0.00000001 BTC.
  const balanceSat = data.chain_stats.funded_txo_sum - data.chain_stats.spent_txo_sum;
  // Переводим сатоши в BTC (1 BTC = 100_000_000 сатоши).
  const balanceBTC = balanceSat / 1e8;
  const formatted = balanceBTC.toFixed(4);
  console.log(JSON.stringify({ address, balance: formatted }));
}

getBalance("tb1qtt7evtxg4vqm5k27m6ftzzjprlhvpl39t37nalrr845j4allcd7qssh0cp");