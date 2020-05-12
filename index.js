const START = Date.now();
const Nimiq = require('@nimiq/core');

require('dotenv').config();

const config = {
	protocol: "dumb",
	network: process.env.NETWORK || "main",
	type: "nano"
};

const io = require("socket.io");
const server = io.listen(process.env.PORT);

// event fired every time a new client connects:
server.on("connection", (socket) => {
	console.info(`Client connected [id=${socket.id}]`);

	socket.on("disconnect", () => {
		console.info(`Client gone [id=${socket.id}]`);
	});

	socket.on("subscribe", (data) => {
		socket.join(data, () => {
			console.info(`Subscribed ${data}`);
		});
	});

	socket.on("unsubscribe", (data) => {
		socket.leave(data, () => {
			console.info(`Unsubscribed ${data}`);
		});
	});
});

/*
// sends test transactions
const dummy = {
	txid: "...",
	value: 123,
	recipient: "NQ..."
};

setInterval(() => {
	server.to('inv').emit('tx', dummy);
}, 5000);
*/

// Deprecated dumb config flag.
if (config.dumb) {
	console.error(`The '--dumb' flag is deprecated, use '--protocol=dumb' instead.`);
	config.protocol = 'dumb';
}

const isNano = config.type === 'nano';

if (!Nimiq.GenesisConfig.CONFIGS[config.network]) {
	console.error(`Invalid network name: ${config.network}`);
	process.exit(1);
}
if (config.host && config.protocol === 'dumb') {
	console.error('Cannot use both --host and --protocol=dumb');
	process.exit(1);
}
if (config.type === 'light') {
	console.error('Light node type is temporarily disabled');
	process.exit(1);
}

for (const key in config.constantOverrides) {
	Nimiq.ConstantHelper.instance.set(key, config.constantOverrides[key]);
}

const TAG = 'Node';
const $ = {};

(async () => {
	if (config.protocol === 'dumb') {
		Nimiq.Log.e(TAG, `******************************************************************************`);
		Nimiq.Log.e(TAG, `*																			*`);
		Nimiq.Log.e(TAG, `*  You are running in 'dumb' configuration, so others can't connect to you.  *`);
		Nimiq.Log.e(TAG, `*  Consider switching to a proper WebSocket/WebSocketSecure configuration.   *`);
		Nimiq.Log.e(TAG, `*																			*`);
		Nimiq.Log.e(TAG, `******************************************************************************`);
	}

	Nimiq.Log.i(TAG, `Nimiq NodeJS Client starting (network=${config.network}`
		+ `, ${config.host ? `host=${config.host}, port=${config.port}` : 'dumb'})`);

	Nimiq.GenesisConfig.init(Nimiq.GenesisConfig.CONFIGS[config.network]);

	let networkConfig;
	switch (config.protocol) {
		case 'wss':
			networkConfig = new Nimiq.WssNetworkConfig(config.host, config.port, config.tls.key, config.tls.cert, config.reverseProxy);
			break;
		case 'ws':
			networkConfig = new Nimiq.WsNetworkConfig(config.host, config.port, config.reverseProxy);
			break;
		case 'dumb':
			networkConfig = new Nimiq.DumbNetworkConfig();
			break;
	}

	switch (config.type) {
		case 'full':
			$.consensus = await Nimiq.Consensus.full(networkConfig);
			break;
		case 'light':
			$.consensus = await Nimiq.Consensus.light(networkConfig);
			break;
		case 'nano':
			$.consensus = await Nimiq.Consensus.nano(networkConfig);
			break;
	}

	$.blockchain = $.consensus.blockchain;
	$.accounts = $.blockchain.accounts;
	$.mempool = $.consensus.mempool;
	$.network = $.consensus.network;

	Nimiq.Log.i(TAG, `Peer address: ${networkConfig.peerAddress.toString()} - public key: ${networkConfig.keyPair.publicKey.toHex()}`);

	$.walletStore = await new Nimiq.WalletStore();
	$.wallet = await $.walletStore.getDefault();

	const addresses = await $.walletStore.list();
	Nimiq.Log.i(TAG, `Managing wallets [${addresses.map(address => address.toUserFriendlyAddress())}]`);

	const account = !isNano ? await $.accounts.get($.wallet.address) : null;
	Nimiq.Log.i(TAG, `Wallet initialized for address ${$.wallet.address.toUserFriendlyAddress()}.`
		+ (!isNano ? ` Balance: ${Nimiq.Policy.lunasToCoins(account.balance)} NIM` : ''));

	Nimiq.Log.i(TAG, `Blockchain state: height=${$.blockchain.height}, headHash=${$.blockchain.headHash}`);

	$.blockchain.on('head-changed', async (head) => {
		if ($.consensus.established) {
			const hash = await $.consensus.getHeadHash();
			const block = await $.consensus.getBlock(hash, true);
			const transactions = block.body.transactions;
			for (const transaction of transactions) {
				const address = transaction.recipient.toUserFriendlyAddress()
				const data = {
					txid: transaction.hash().toPlain(),
					value: transaction.value,
					recipient: address
				};
				server.to(address.replace(/ /g,'')).emit('tx', data);
				console.log(`TX sent ${data.txid}`);
			}
		}
	});

	$.network.on('peer-joined', (peer) => {
		Nimiq.Log.i(TAG, `Connected to ${peer.peerAddress.toString()}`);
	});
	$.network.on('peer-left', (peer) => {
		Nimiq.Log.i(TAG, `Disconnected from ${peer.peerAddress.toString()}`);
	});

	const isSeed = (peerAddress) => Nimiq.GenesisConfig.SEED_PEERS.some(seed => seed.equals(peerAddress));
	$.network.on('peer-joined', (peer) => {
		if (Math.abs(peer.timeOffset) > Nimiq.Network.TIME_OFFSET_MAX && isSeed(peer.peerAddress)) {
			Nimiq.Log.e(TAG, 'Your local system time seems to be wrong! You might not be able to synchronize with the network.');
		}
	});

	if (!config.passive) {
		$.network.connect();
	} else {
		$.network.allowInboundConnections = true;
	}

	$.consensus.on('established', () => {
		Nimiq.Log.i(TAG, `Blockchain ${config.type}-consensus established in ${(Date.now() - START) / 1000}s.`);
		Nimiq.Log.i(TAG, `Current state: height=${$.blockchain.height}, totalWork=${$.blockchain.totalWork}, headHash=${$.blockchain.headHash}`);
	});
})().catch(e => {
	console.error(e);
	process.exit(1);
});
