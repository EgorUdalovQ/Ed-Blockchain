const fetch = (...args) => import('node-fetch').then(mod => mod.default(...args));

// ============================================================================
// Создание и отправка биткоин-транзакции в HD-кошельке (BIP84, testnet4)
// Подробное описание алгоритма см. в README.md
// ============================================================================

// bitcoinjs-lib — основная библиотека для работы с биткоином на JavaScript.
// Предоставляет функции для построения PSBT, преобразования адресов,
// проверки подписей и работы с P2WPKH (Pay to Witness Public Key Hash).
const bitcoin = require('bitcoinjs-lib');

// tiny-secp256k1 — криптографическая библиотека для эллиптической кривой secp256k1.
// Используется для создания и проверки ECDSA-подписей, которые необходимы для подписания входов транзакции.
const ecc = require('tiny-secp256k1');

// ecpair — вспомогательная библиотека для управления парами ключей (публичный и приватный).
// ECPairFactory создаёт фабрику для генерации пар ключей с поддержкой криптографии (ecc).
// Не используется напрямую, но нужен для работы bip32 и подписания.
const ECPairFactory = require('ecpair').ECPairFactory;
const ECPair = ECPairFactory(ecc);

// coinselect — библиотека для интеллектуального выбора монет (UTXO selection).
// Анализирует доступные входы (UTXO) и выбирает оптимальный набор для покрытия суммы платежа + комиссии,
// минимизируя размер транзакции и, следовательно, её стоимость.
const coinselect = require('coinselect');

// bip39 — библиотека для работы с мнемоническими фразами (seed-фразами из 12/24 слов).
// Позволяет генерировать seed из фразы и использовать его для деривации ключей.
const bip39 = require('bip39');

// bip32 — библиотека для иерархической деривации ключей (HD wallets, BIP32).
// Позволяет из одного master seed генерировать дерево приватных/публичных ключей
// по путям типа m/84'/1'/0'/0/0 (BIP84 для native segwit testnet).
const BIP32Factory = require('bip32').BIP32Factory;
const bip32 = BIP32Factory(ecc);

const NETWORK = bitcoin.networks.testnet;

// Деривация ключа и адреса из мнемоники по пути BIP84 (native segwit testnet)
async function deriveKeyAndAddress(mnemonic, accountIndex = 1, changeIndex = 0, addressIndex = 0) {
  const seed = await bip39.mnemonicToSeed(mnemonic);
  const root = bip32.fromSeed(seed, NETWORK);
  // BIP44 path для testnet: m/44'/1'/account'/change/address_index
  const path = `m/44'/1'/${accountIndex}'/${changeIndex}/${addressIndex}`;
  const child = root.derivePath(path);
  const { address } = bitcoin.payments.p2wpkh({ pubkey: child.publicKey, network: NETWORK });
  return { keyPair: child, address };
}

// Сканируем адреса кошелька (receiving + change) и собираем все UTXO
async function scanAddressesForUTXO(mnemonic, accountIndex = 1, gapLimit = 20) {
  const allUTXOs = [];
  
  // Сканируем receiving адреса (change=0)
  let emptyCount = 0;
  let addressIndex = 0;

  while (emptyCount < gapLimit) {
    const { keyPair, address } = await deriveKeyAndAddress(mnemonic, accountIndex, 0, addressIndex);
    const utxos = await fetch(`https://mempool.space/testnet4/api/address/${address}/utxo`).then(r => r.json());
    
    if (utxos.length === 0) {
      emptyCount++;
    } else {
      emptyCount = 0;
      // Сохраняем UTXO с keyPair и адресом
      utxos.forEach(u => allUTXOs.push({ ...u, keyPair, address }));
    }
    addressIndex++;
  }
  
  // Сканируем change адреса (change=1, сдача)
  emptyCount = 0;
  addressIndex = 0;

  while (emptyCount < gapLimit) {
    const { keyPair, address } = await deriveKeyAndAddress(mnemonic, accountIndex, 1, addressIndex);
    const utxos = await fetch(`https://mempool.space/testnet4/api/address/${address}/utxo`).then(r => r.json());
    
    if (utxos.length === 0) {
      emptyCount++;
    } else {
      emptyCount = 0;
      utxos.forEach(u => allUTXOs.push({ ...u, keyPair, address }));
    }
    addressIndex++;
  }
  
  return allUTXOs;
}

async function sendFromHDWallet({ mnemonic, toAddress, amountBTC, feeRate, accountIndex = 1 }) {
  // Конвертируем BTC в сатоши (округляем до целого числа сатоши).
  const amountSat = Math.round(Number(amountBTC) * 1e8);
  // 1) Сканируем адреса и собираем все UTXO из HD-кошелька
  const allUTXOs = await scanAddressesForUTXO(mnemonic, accountIndex);

  // Преобразуем в формат, удобный для coinselect (поле `value` в сатоши)
  const inputs = allUTXOs.map(u => ({ txid: u.txid, vout: u.vout, value: u.value, keyPair: u.keyPair, address: u.address }));

  // 2) Выбираем монеты через coinselect: возвращает inputs, outputs, fee
  const targets = [{ address: toAddress, value: amountSat }];
  const { inputs: selectedInputs, outputs: selectedOutputs, fee } = coinselect(inputs, targets, feeRate);

  if (!selectedInputs || !selectedOutputs) throw new Error('Insufficient funds');

  // 3) Собираем PSBT
  const psbt = new bitcoin.Psbt({ network: NETWORK });

  // Добавляем входы (используем witnessUtxo для native segwit входов)
  for (const inp of selectedInputs) {
    const script = bitcoin.address.toOutputScript(inp.address, NETWORK);
    psbt.addInput({
      hash: inp.txid,
      index: inp.vout,
      witnessUtxo: { 
        script: script, 
        value: BigInt(inp.value) // Конвертируем в bigint
      }
    });
  }

  // Добавляем выходы; coinselect может вернуть выход для сдачи без `address` (в этом случае назначаем сдачу на change-адрес)
  for (const out of selectedOutputs) {
    if (!out.address) {
      // Генерируем change-адрес (change=1 path, m/44'/1'/accountIndex'/1/0)
      const { address: changeAddress } = await deriveKeyAndAddress(mnemonic, accountIndex, 1, 0);
      out.address = changeAddress;
    }
    psbt.addOutput({ 
      address: out.address, 
      value: BigInt(out.value) // Конвертируем в bigint
    });
  }

  // 4) Подписываем входы (каждый вход своим keyPair)
  selectedInputs.forEach((inp, idx) => psbt.signInput(idx, inp.keyPair));

  // 5) Финализируем PSBT и получаем raw-транзакцию в hex
  psbt.finalizeAllInputs();
  const rawTx = psbt.extractTransaction().toHex();

  // 6) Отправляем raw-транзакцию через mempool.space
  const res = await fetch('https://mempool.space/testnet4/api/tx', {
    method: 'POST',
    body: rawTx,
    headers: { 'Content-Type': 'text/plain' }
  });
  const txid = await res.text();

  return { txid, rawTx, fee };
}

(async () => {
  // Мнемоническая фраза (12 слов) — ЗАМЕНИТЕ НА ВАШУ ТЕСТОВУЮ SEED-ФРАЗУ
  const mnemonic = 'edit duck coil speed afraid silly blouse abstract recycle decide cart survey';
  const toAddress = 'tb1q0d9858u4jv6qmlk7cum4d0uwxd2l54vk8mvpe6';
  const amountBTC = 0.0001;
  // feeRate — комиссия в сатоши за виртуальный байт (sat/vbyte)
  // Чем выше значение, тем быстрее транзакция попадёт в блок
  // Для testnet обычно достаточно 1-2 sat/vbyte
  // Для mainnet смотрите актуальные ставки: mempool.space
  const feeRate = 2;
  // accountIndex — номер счёта в HD кошельке
  // 0 = первый счёт (m/44'/1'/0'/...)
  // 1 = второй счёт (m/44'/1'/1'/...)
  // 2 = третий счёт (m/44'/1'/2'/...)
  const accountIndex = 0;

  const result = await sendFromHDWallet({ mnemonic, toAddress, amountBTC, feeRate, accountIndex });
  console.log('\n✅ Транзакция отправлена!');
  console.log(`\nTXID: ${result.txid}`);
  console.log(`Комиссия: ${result.fee} sat (${(result.fee / 1e8).toFixed(8)} BTC)`);
  console.log(`\n🔗 Посмотреть транзакцию:`);
  console.log(`https://mempool.space/testnet4/tx/${result.txid}`);
})();
