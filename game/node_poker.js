/**
 * Created by the-engine-team
 * 2017-08-21
 */

var events = require('events');
var playerDao = require('../models/player_dao.js');
var winnerDao = require('../models/winner_dao.js');
var logger = require('../poem/logging/logger4js').helper;

var Enums = require('../constants/enums.js');
var enums = new Enums();

function Table(smallBlind, bigBlind, minPlayers, maxPlayers, initChips, maxReloadCount, maxRoundCount) {
    this.smallBlind = smallBlind;
    this.bigBlind = bigBlind;
    this.minPlayers = minPlayers;
    this.maxPlayers = maxPlayers;
    this.players = [];
    this.timeout = null;
    this.dealer = 0; // Track the dealer position between games
    this.initChips = initChips;
    this.maxReloadCount = maxReloadCount;
    this.playersToRemove = [];
    this.playersToAdd = [];
    this.eventEmitter = new events.EventEmitter();
    this.turnBet = {};
    this.gameWinners = [];
    this.gameLosers = [];
    this.currentPlayer = 0;
    this.raiseCount = 0;
    this.betCount = 0;
    this.isBet = false;
    this.roundCount = 1;
    this.surviveCount = 0;
    this.isReloadTime = false;
    this.maxRoundCount = maxRoundCount;
    this.firstDealer = 0;
    this.status = enums.GAME_STATUS_STANDBY;
    this.smallBlindIndex = 0;
    this.bigBlindIndex = 0;
    this.isActionTime = false;
    this.reloadTimeOut = null;
    this.countDown = 3;

    // Validate acceptable value ranges.
    var err;
    if (minPlayers < 3) { // Require at least 3 players to start a game.
        err = new Error(101, 'Parameter [minPlayers] must be a postive integer of a minimum value of 2.');
    } else if (maxPlayers > 10) { // Hard limit of 10 players at a table.
        err = new Error(102, 'Parameter [maxPlayers] must be a positive integer less than or equal to 10.');
    } else if (minPlayers > maxPlayers) { // Without this we can never start a game!
        err = new Error(103, 'Parameter [minPlayers] must be less than or equal to [maxPlayers].');
    }
    var that = this;
    if (err) {
        return err;
    }

    this.eventEmitter.on('newRound', function () {
        logGame(that.tableNumber, 'new round : ' + that.roundCount);
        // reset raise count and bet count
        that.raiseCount = 0;
        that.betCount = 0;

        logGame(that.tableNumber, 'start get first player');
        getNextPlayer(that);

        logGame(that.tableNumber, 'start get first player:' + that.currentPlayer + ' action ');
        takeAction(that, '__turn');

        var tempData = [];
        for (var i = 0; i < that.players.length; i++) {
            tempData.push({playerName: that.players[i].playerName, chips: that.players[i].chips});
        }
        playerDao.updatePlayerChips(tempData, function () {
            // Do nothing
            logGame(that.tableNumber, 'update player chip success ');
        });
    });

    this.eventEmitter.on('showAction', function (data) {
        var myData = getBasicData(that);
        myData.action = data;
        logGame(that.tableNumber, 'show action : ' + JSON.stringify(myData));
        that.eventEmitter.emit('__show_action', myData);
    });

    this.eventEmitter.on('deal', function () {
        if (that.surviveCount <= 1) {
            for (var j = 0; j < that.players.length; j++)
                that.players[j].talked = true;
            progress(that);
        } else {
            that.currentPlayer = that.smallBlindIndex - 1;
            that.isBet = true;
            getNextPlayer(that);
            that.raiseCount = 0;
            that.betCount = 0;
            takeAction(that, '__bet');
        }
    });

    this.eventEmitter.on('roundEnd', function () {
        var count = 0;
        var i;
        var data;
        for (i = 0; i < that.players.length; i++) {
            if (that.players[i].chips <= 0 && that.players[i].reloadCount < that.maxReloadCount) {
                that.players[i].reloadCount++;
                that.players[i].chips = that.initChips;
            }
            if (that.players[i].chips > 0) {
                count++;
            }
        }

        logGame(that.tableNumber, 'round end');
        logGame(that.tableNumber, '********');
        logGame(that.tableNumber, 'alive player count = ' + count + ', players.length / 2 = ' + that.players.length / 2);
        logGame(that.tableNumber, 'minPlayers = ' + that.minPlayers);
        logGame(that.tableNumber, 'roundCount = ' + that.roundCount + ', maxRoundCount = ' + that.maxRoundCount);
        logGame(that.tableNumber, '********');

        if (count > that.players.length / 2 && count >= that.minPlayers && that.roundCount < that.maxRoundCount) {
            data = getBasicData(that);
            that.eventEmitter.emit('__round_end', data);
            that.surviveCount = count;
            for (var j = 0; j < that.players.length; j++) {
                var isSurvive = true;
                if (that.players[j].chips === 0)
                    isSurvive = false;
                that.players[j] = new Player(that.players[j].playerName, that.players[j].chips,
                    that, isSurvive, that.players[j].reloadCount);
            }
            that.game = new Game(that.smallBlind, that.bigBlind);
            var nextDealer = getNextDealer(that);
            logGame(that.tableNumber, 'current dealer is : ' + that.dealer + ' next is:' + nextDealer);
            that.dealer = nextDealer;
            that.roundCount++;
            that.isReloadTime = true;
            that.eventEmitter.emit('__start_reload', getPlayerReloadData(that));
            logGame(that.tableNumber, 'start reload');
            that.reloadTimeOut = setTimeout(function () {
                that.reloadTimeOut = null;
                if (that.status !== enums.GAME_STATUS_RUNNING) {
                    logGame(that.tableNumber, 'game is not started yet or is over, do nothing');
                    return;
                }
                that.isReloadTime = false;
                that.isBet = false;
                logGame(that.tableNumber, "reload time end, start new round");
                that.NewRound();
            }, 5 * 1000);
        } else {
            logGame(that.tableNumber, 'game over, winners : ');
            that.status = enums.GAME_STATUS_FINISHED;
            for (i = 0; i < that.players.length; i++) {
                var player = that.players[i];
                player.chips += (that.maxReloadCount - player.reloadCount) * that.initChips;
                if (player.chips > 0)
                    that.gameWinners.push({
                        playerName: that.players[i].playerName,
                        hand: that.players[i].hand,
                        chips: that.players[i].chips
                    });
            }
            sort(that.gameWinners);
            logGame(that.tableNumber, JSON.stringify(that.gameWinners));
            data = getBasicData(that);
            data.winners = that.gameWinners;
            winnerDao.addOrUpdateWinner({tableNumber: that.tableNumber, winners: that.gameWinners});
            that.eventEmitter.emit('__game_over', data);
        }
    });
}

function getBasicData(table) {
    var players = [];
    var myTable = {};
    var data = {};

    for (var i = 0; i < table.players.length; i++) {
        var player = {};
        player['playerName'] = table.players[i]['playerName'];
        player['chips'] = table.players[i]['chips'];
        player['folded'] = table.players[i]['folded'];
        player['allIn'] = table.players[i]['allIn'];
        player['cards'] = table.players[i]['cards'];
        player['isSurvive'] = table.players[i]['isSurvive'];
        player['reloadCount'] = table.players[i]['reloadCount'];
        // include bets info
        if (table.game) {
            player['roundBet'] = table.game.roundBets[i];
            player['bet'] = table.game.bets[i];
        }
        players.push(player);
    }
    var sbPlayerIndex = table.smallBlindIndex;
    var bbPlayerIndex = table.bigBlindIndex;

    myTable['tableNumber'] = table.tableNumber;
    myTable['status'] = table.status;
    myTable['roundName'] = table.game.roundName;
    myTable['board'] = table.game.board;
    myTable['roundCount'] = table.roundCount;
    myTable['raiseCount'] = table.raiseCount;
    myTable['betCount'] = table.betCount;
    if (-1 !== sbPlayerIndex) {
        myTable['smallBlind'] = {
            playerName: table.players[sbPlayerIndex].playerName,
            amount: table.smallBlind
        };
    }

    if (-1 !== bbPlayerIndex) {
        myTable['bigBlind'] = {
            playerName: table.players[bbPlayerIndex].playerName,
            amount: table.bigBlind
        };
    }
    data.players = players;
    data.table = myTable;
    return data;
}

function getPlayerReloadData(table) {
    var players = [];
    var data = {};
    for (var i = 0; i < table.players.length; i++) {
        var player = {};
        player['playerName'] = table.players[i]['playerName'];
        player['chips'] = table.players[i]['chips'];
        player['folded'] = table.players[i]['folded'];
        player['allIn'] = table.players[i]['allIn'];
        player['isSurvive'] = table.players[i]['isSurvive'];
        player['reloadCount'] = table.players[i]['reloadCount'];
        players.push(player);
    }
    data.players = players;
    data.tableNumber = table.tableNumber;
    return data;
}

function getNextPlayer(table) {
    if (!table) {
        logger.error('table is destroyed');
    }

    logGame(table.tableNumber, "get next player");
    var maxBet = getMaxBet(table.game.bets);
    do {
        table.currentPlayer = (table.currentPlayer >= table.players.length - 1) ?
            (table.currentPlayer - table.players.length + 1) : (table.currentPlayer + 1 );
        logGame(table.tableNumber, 'traverse : ' + table.players[table.currentPlayer].playerName);

    } while (!table.players[table.currentPlayer].isSurvive ||
    table.players[table.currentPlayer].folded ||
    table.players[table.currentPlayer].allIn ||
    (table.players[table.currentPlayer].talked === true &&
    table.game.bets[table.currentPlayer] === maxBet));
}

function getNextDealer(table) {
    var index = table.dealer;
    var players = table.players;
    var isNeedModifyFirstDealer = false;
    do {
        index = (index >= players.length - 1) ? (index - players.length + 1) : index + 1;
        if (index === table.firstDealer) {
            table.smallBlind = table.smallBlind * 2;
            table.bigBlind = table.bigBlind * 2;
            isNeedModifyFirstDealer = true;
        }
    } while (!players[index].isSurvive);
    if (isNeedModifyFirstDealer)
        table.firstDealer = index;
    return index;
}

function sort(data) {
    for (var k = 0; k < data.length; k++) {
        for (var p = k + 1; p < data.length; p++) {
            if (data[p].chips > data[k].chips || (data[p].chips === data[k].chips && data[p].hand.rank > data[k].hand.rank)) {
                var temp = data[k];
                data[k] = data[p];
                data[p] = temp;
            }
        }
    }
}

function takeAction(table, action) {
    var players = [];
    var destPlayer = {};
    for (var i = 0; i < table.players.length; i++) {
        var player = {};
        player['playerName'] = table.players[i]['playerName'];
        player['chips'] = table.players[i]['chips'];
        player['folded'] = table.players[i]['folded'];
        player['allIn'] = table.players[i]['allIn'];
        player['isSurvive'] = table.players[i]['isSurvive'];
        player['reloadCount'] = table.players[i]['reloadCount'];
        player['roundBet'] = table.game.roundBets[i];
        player['bet'] = table.game.bets[i];
        if (i === table.currentPlayer) {
            player['cards'] = table.players[i]['cards'];
            destPlayer = player;
        }
        players.push(player);
    }

    var sbPlayerIndex = table.smallBlindIndex;
    var bbPlayerIndex = table.bigBlindIndex;

    var data = {
        'tableNumber': table.tableNumber,
        'self': destPlayer,
        'game': {
            'board': table.game.board,
            'minBet': table.bigBlind,
            'roundName': table.game.roundName,
            'roundCount': table.roundCount,
            'raiseCount': table.raiseCount,
            'betCount': table.betCount,
            'players': players,
            'smallBlind': {
                playerName: table.players[sbPlayerIndex].playerName,
                amount: table.smallBlind
            },
            'bigBlind': {
                playerName: table.players[bbPlayerIndex].playerName,
                amount: table.bigBlind
            }
        }
    };

    table.eventEmitter.emit(action, data);
    table.isActionTime = true;
}

Table.prototype.resetCountDown = function() {
    this.countDown = 3;
};

Table.prototype.checkPlayer = function (player) {
    return player === this.currentPlayer;
};

function Player(playerName, chips, table, isSurvive, reloadCount) {
    this.playerName = playerName;
    this.chips = chips;
    this.folded = false;
    this.allIn = false;
    this.talked = false;
    this.table = table; // Circular reference to allow reference back to parent object.
    this.cards = [];
    this.isSurvive = isSurvive;
    this.reloadCount = reloadCount;
}

function fillDeck(deck) {
    deck.push('AS');
    deck.push('KS');
    deck.push('QS');
    deck.push('JS');
    deck.push('TS');
    deck.push('9S');
    deck.push('8S');
    deck.push('7S');
    deck.push('6S');
    deck.push('5S');
    deck.push('4S');
    deck.push('3S');
    deck.push('2S');
    deck.push('AH');
    deck.push('KH');
    deck.push('QH');
    deck.push('JH');
    deck.push('TH');
    deck.push('9H');
    deck.push('8H');
    deck.push('7H');
    deck.push('6H');
    deck.push('5H');
    deck.push('4H');
    deck.push('3H');
    deck.push('2H');
    deck.push('AD');
    deck.push('KD');
    deck.push('QD');
    deck.push('JD');
    deck.push('TD');
    deck.push('9D');
    deck.push('8D');
    deck.push('7D');
    deck.push('6D');
    deck.push('5D');
    deck.push('4D');
    deck.push('3D');
    deck.push('2D');
    deck.push('AC');
    deck.push('KC');
    deck.push('QC');
    deck.push('JC');
    deck.push('TC');
    deck.push('9C');
    deck.push('8C');
    deck.push('7C');
    deck.push('6C');
    deck.push('5C');
    deck.push('4C');
    deck.push('3C');
    deck.push('2C');

    // Shuffle the deck array with Fisher-Yates
    var i, j, tempi, tempj;
    for (i = 0; i < deck.length; i += 1) {
        j = Math.floor(Math.random() * (i + 1));
        tempi = deck[i];
        tempj = deck[j];
        deck[i] = tempj;
        deck[j] = tempi;
    }
}

function getMaxBet(bets) {
    var maxBet, i;
    maxBet = 0;
    for (i = 0; i < bets.length; i += 1) {
        if (bets[i] > maxBet) {
            maxBet = bets[i];
        }
    }
    return maxBet;
}

function checkForEndOfRound(table, maxBet) {
    var i, endOfRound;
    endOfRound = true;
    // For each player, check
    for (i = 0; i < table.players.length; i += 1) {
        if (table.players[i].isSurvive && table.players[i].folded === false) {
            if (table.players[i].talked === false || table.game.bets[i] !== maxBet) {
                if (table.players[i].allIn === false) {
                    endOfRound = false;
                }
            }
        }
    }
    return endOfRound;
}

function checkForAllInPlayer(table, winners) {
    var i, allInPlayer;
    allInPlayer = [];
    for (i = 0; i < winners.length; i += 1) {
        if (table.players[winners[i]].allIn === true) {
            allInPlayer.push(winners[i]);
        }
    }
    return allInPlayer;
}

function checkForWinner(table) {
    logGame(table.tableNumber, 'check for winner');
    var i, j, k, l, maxRank, winners, part, prize, allInPlayer, minBets, roundEnd;
    // Identify winner(s)
    winners = [];
    maxRank = 0.000;
    for (k = 0; k < table.players.length; k += 1) {
        if (table.players[k].hand.rank === maxRank && table.players[k].folded === false) {
            winners.push(k);
        }
        if (table.players[k].hand.rank > maxRank && table.players[k].folded === false) {
            maxRank = table.players[k].hand.rank;
            winners.splice(0, winners.length);
            winners.push(k);
        }
    }

    part = 0;
    prize = 0;
    allInPlayer = checkForAllInPlayer(table, winners);

    if (allInPlayer.length > 0) {
        minBets = table.game.roundBets[winners[0]];
        for (j = 1; j < allInPlayer.length; j += 1) {
            if (table.game.roundBets[winners[j]] !== 0 && table.game.roundBets[winners[j]] < minBets) {
                minBets = table.game.roundBets[winners[j]];
            }
        }
        part = parseInt(minBets);
    } else {
        part = parseInt(table.game.roundBets[winners[0]]);
    }
    for (l = 0; l < table.game.roundBets.length; l += 1) {
        if (table.game.roundBets[l] > part) {
            prize += part;
            table.game.roundBets[l] -= part;
        } else {
            prize += table.game.roundBets[l];
            table.game.roundBets[l] = 0;
        }
    }

    for (i = 0; i < winners.length; i += 1) {
        //var winnerPrize = Math.round(prize * 100 / winners.length) / 100;
        var winnerPrize = parseInt(prize / winners.length);
        var winningPlayer = table.players[winners[i]];
        winningPlayer.chips += winnerPrize;
        if (table.game.roundBets[winners[i]] === 0) {
            winningPlayer.folded = true;
        }
    }

    roundEnd = true;
    for (l = 0; l < table.game.roundBets.length; l += 1) {
        logGame(table.tableNumber, 'table.game.roundBets[' + l + '] = ' + table.game.roundBets[l]);

        if (table.game.roundBets[l] !== 0) {
            //logGame(table.tableNumber, 'roundBets[' + l + '] = ' + table.game.roundBets[l] + ' part = ' + part);
            roundEnd = false;
        }
    }
    if (roundEnd === false) {
        checkForWinner(table);
    }
}

function checkForBankrupt(table) {
    var i;
    for (i = 0; i < table.players.length; i += 1) {
        if (table.players[i].chips === 0) {
            table.gameLosers.push(table.players[i]);
            logGame(table.tableNumber, 'player : ' + table.players[i].playerName + ' is going bankrupt');
            table.players.splice(i, 1);
        }
    }
}

function Hand(cards) {
    this.cards = cards;
}

function sortNumber(a, b) {
    return b - a;
}

function Result(rank, message) {
    this.rank = rank;
    this.message = message;
}

function rankKickers(ranks, noOfCards) {
    var i, kickerRank, myRanks, rank;

    kickerRank = 0.0000;
    myRanks = [];
    rank = '';

    for (i = 0; i <= ranks.length; i += 1) {
        rank = ranks.substr(i, 1);

        if (rank === 'A') {
            myRanks.push(0.2048);
        }
        if (rank === 'K') {
            myRanks.push(0.1024);
        }
        if (rank === 'Q') {
            myRanks.push(0.0512);
        }
        if (rank === 'J') {
            myRanks.push(0.0256);
        }
        if (rank === 'T') {
            myRanks.push(0.0128);
        }
        if (rank === '9') {
            myRanks.push(0.0064);
        }
        if (rank === '8') {
            myRanks.push(0.0032);
        }
        if (rank === '7') {
            myRanks.push(0.0016);
        }
        if (rank === '6') {
            myRanks.push(0.0008);
        }
        if (rank === '5') {
            myRanks.push(0.0004);
        }
        if (rank === '4') {
            myRanks.push(0.0002);
        }
        if (rank === '3') {
            myRanks.push(0.0001);
        }
        if (rank === '2') {
            myRanks.push(0.0000);
        }
    }

    myRanks.sort(sortNumber);

    for (i = 0; i < noOfCards; i += 1) {
        kickerRank += myRanks[i];
    }

    return kickerRank;
}

function rankHandInt(hand) {
    var rank, message, handRanks, handSuits, ranks, suits, cards, result, i;

    rank = 0.0000;
    message = '';
    handRanks = [];
    handSuits = [];

    for (i = 0; i < hand.cards.length; i += 1) {
        logger.info("hand.cards[" + i + "] = " + hand.cards[i]);
        handRanks[i] = hand.cards[i].substr(0, 1);
        handSuits[i] = hand.cards[i].substr(1, 2);
    }

    ranks = handRanks.sort().toString().replace(/\W/g, '');
    suits = handSuits.sort().toString().replace(/\W/g, '');
    cards = hand.cards.toString();

    // Four of a kind
    if (rank === 0) {
        if (ranks.indexOf('AAAA') > -1) {
            rank = 292 + rankKickers(ranks.replace('AAAA', ''), 1);
        }
        if (ranks.indexOf('KKKK') > -1 && rank === 0) {
            rank = 291 + rankKickers(ranks.replace('KKKK', ''), 1);
        }
        if (ranks.indexOf('QQQQ') > -1 && rank === 0) {
            rank = 290 + rankKickers(ranks.replace('QQQQ', ''), 1);
        }
        if (ranks.indexOf('JJJJ') > -1 && rank === 0) {
            rank = 289 + rankKickers(ranks.replace('JJJJ', ''), 1);
        }
        if (ranks.indexOf('TTTT') > -1 && rank === 0) {
            rank = 288 + rankKickers(ranks.replace('TTTT', ''), 1);
        }
        if (ranks.indexOf('9999') > -1 && rank === 0) {
            rank = 287 + rankKickers(ranks.replace('9999', ''), 1);
        }
        if (ranks.indexOf('8888') > -1 && rank === 0) {
            rank = 286 + rankKickers(ranks.replace('8888', ''), 1);
        }
        if (ranks.indexOf('7777') > -1 && rank === 0) {
            rank = 285 + rankKickers(ranks.replace('7777', ''), 1);
        }
        if (ranks.indexOf('6666') > -1 && rank === 0) {
            rank = 284 + rankKickers(ranks.replace('6666', ''), 1);
        }
        if (ranks.indexOf('5555') > -1 && rank === 0) {
            rank = 283 + rankKickers(ranks.replace('5555', ''), 1);
        }
        if (ranks.indexOf('4444') > -1 && rank === 0) {
            rank = 282 + rankKickers(ranks.replace('4444', ''), 1);
        }
        if (ranks.indexOf('3333') > -1 && rank === 0) {
            rank = 281 + rankKickers(ranks.replace('3333', ''), 1);
        }
        if (ranks.indexOf('2222') > -1 && rank === 0) {
            rank = 280 + rankKickers(ranks.replace('2222', ''), 1);
        }
        if (rank !== 0) {
            message = 'Four of a kind';
        }
    }

    // Full House
    if (rank === 0) {
        if (ranks.indexOf('AAA') > -1 && ranks.indexOf('KK') > -1) {
            rank = 279;
        }
        if (ranks.indexOf('AAA') > -1 && ranks.indexOf('QQ') > -1 && rank === 0) {
            rank = 278;
        }
        if (ranks.indexOf('AAA') > -1 && ranks.indexOf('JJ') > -1 && rank === 0) {
            rank = 277;
        }
        if (ranks.indexOf('AAA') > -1 && ranks.indexOf('TT') > -1 && rank === 0) {
            rank = 276;
        }
        if (ranks.indexOf('AAA') > -1 && ranks.indexOf('99') > -1 && rank === 0) {
            rank = 275;
        }
        if (ranks.indexOf('AAA') > -1 && ranks.indexOf('88') > -1 && rank === 0) {
            rank = 274;
        }
        if (ranks.indexOf('AAA') > -1 && ranks.indexOf('77') > -1 && rank === 0) {
            rank = 273;
        }
        if (ranks.indexOf('AAA') > -1 && ranks.indexOf('66') > -1 && rank === 0) {
            rank = 272;
        }
        if (ranks.indexOf('AAA') > -1 && ranks.indexOf('55') > -1 && rank === 0) {
            rank = 271;
        }
        if (ranks.indexOf('AAA') > -1 && ranks.indexOf('44') > -1 && rank === 0) {
            rank = 270;
        }
        if (ranks.indexOf('AAA') > -1 && ranks.indexOf('33') > -1 && rank === 0) {
            rank = 269;
        }
        if (ranks.indexOf('AAA') > -1 && ranks.indexOf('22') > -1 && rank === 0) {
            rank = 268;
        }
        if (ranks.indexOf('KKK') > -1 && ranks.indexOf('AA') > -1 && rank === 0) {
            rank = 267;
        }
        if (ranks.indexOf('KKK') > -1 && ranks.indexOf('QQ') > -1 && rank === 0) {
            rank = 266;
        }
        if (ranks.indexOf('KKK') > -1 && ranks.indexOf('JJ') > -1 && rank === 0) {
            rank = 265;
        }
        if (ranks.indexOf('KKK') > -1 && ranks.indexOf('TT') > -1 && rank === 0) {
            rank = 264;
        }
        if (ranks.indexOf('KKK') > -1 && ranks.indexOf('99') > -1 && rank === 0) {
            rank = 263;
        }
        if (ranks.indexOf('KKK') > -1 && ranks.indexOf('88') > -1 && rank === 0) {
            rank = 262;
        }
        if (ranks.indexOf('KKK') > -1 && ranks.indexOf('77') > -1 && rank === 0) {
            rank = 261;
        }
        if (ranks.indexOf('KKK') > -1 && ranks.indexOf('66') > -1 && rank === 0) {
            rank = 260;
        }
        if (ranks.indexOf('KKK') > -1 && ranks.indexOf('55') > -1 && rank === 0) {
            rank = 259;
        }
        if (ranks.indexOf('KKK') > -1 && ranks.indexOf('44') > -1 && rank === 0) {
            rank = 258;
        }
        if (ranks.indexOf('KKK') > -1 && ranks.indexOf('33') > -1 && rank === 0) {
            rank = 257;
        }
        if (ranks.indexOf('KKK') > -1 && ranks.indexOf('22') > -1 && rank === 0) {
            rank = 256;
        }
        if (ranks.indexOf('QQQ') > -1 && ranks.indexOf('AA') > -1 && rank === 0) {
            rank = 255;
        }
        if (ranks.indexOf('QQQ') > -1 && ranks.indexOf('KK') > -1 && rank === 0) {
            rank = 254;
        }
        if (ranks.indexOf('QQQ') > -1 && ranks.indexOf('JJ') > -1 && rank === 0) {
            rank = 253;
        }
        if (ranks.indexOf('QQQ') > -1 && ranks.indexOf('TT') > -1 && rank === 0) {
            rank = 252;
        }
        if (ranks.indexOf('QQQ') > -1 && ranks.indexOf('99') > -1 && rank === 0) {
            rank = 251;
        }
        if (ranks.indexOf('QQQ') > -1 && ranks.indexOf('88') > -1 && rank === 0) {
            rank = 250;
        }
        if (ranks.indexOf('QQQ') > -1 && ranks.indexOf('77') > -1 && rank === 0) {
            rank = 249;
        }
        if (ranks.indexOf('QQQ') > -1 && ranks.indexOf('66') > -1 && rank === 0) {
            rank = 248;
        }
        if (ranks.indexOf('QQQ') > -1 && ranks.indexOf('55') > -1 && rank === 0) {
            rank = 247;
        }
        if (ranks.indexOf('QQQ') > -1 && ranks.indexOf('44') > -1 && rank === 0) {
            rank = 246;
        }
        if (ranks.indexOf('QQQ') > -1 && ranks.indexOf('33') > -1 && rank === 0) {
            rank = 245;
        }
        if (ranks.indexOf('QQQ') > -1 && ranks.indexOf('22') > -1 && rank === 0) {
            rank = 244;
        }
        if (ranks.indexOf('JJJ') > -1 && ranks.indexOf('AA') > -1 && rank === 0) {
            rank = 243;
        }
        if (ranks.indexOf('JJJ') > -1 && ranks.indexOf('KK') > -1 && rank === 0) {
            rank = 242;
        }
        if (ranks.indexOf('JJJ') > -1 && ranks.indexOf('QQ') > -1 && rank === 0) {
            rank = 241;
        }
        if (ranks.indexOf('JJJ') > -1 && ranks.indexOf('TT') > -1 && rank === 0) {
            rank = 240;
        }
        if (ranks.indexOf('JJJ') > -1 && ranks.indexOf('99') > -1 && rank === 0) {
            rank = 239;
        }
        if (ranks.indexOf('JJJ') > -1 && ranks.indexOf('88') > -1 && rank === 0) {
            rank = 238;
        }
        if (ranks.indexOf('JJJ') > -1 && ranks.indexOf('77') > -1 && rank === 0) {
            rank = 237;
        }
        if (ranks.indexOf('JJJ') > -1 && ranks.indexOf('66') > -1 && rank === 0) {
            rank = 236;
        }
        if (ranks.indexOf('JJJ') > -1 && ranks.indexOf('55') > -1 && rank === 0) {
            rank = 235;
        }
        if (ranks.indexOf('JJJ') > -1 && ranks.indexOf('44') > -1 && rank === 0) {
            rank = 234;
        }
        if (ranks.indexOf('JJJ') > -1 && ranks.indexOf('33') > -1 && rank === 0) {
            rank = 233;
        }
        if (ranks.indexOf('JJJ') > -1 && ranks.indexOf('22') > -1 && rank === 0) {
            rank = 232;
        }
        if (ranks.indexOf('TTT') > -1 && ranks.indexOf('AA') > -1 && rank === 0) {
            rank = 231;
        }
        if (ranks.indexOf('TTT') > -1 && ranks.indexOf('KK') > -1 && rank === 0) {
            rank = 230;
        }
        if (ranks.indexOf('TTT') > -1 && ranks.indexOf('QQ') > -1 && rank === 0) {
            rank = 229;
        }
        if (ranks.indexOf('TTT') > -1 && ranks.indexOf('JJ') > -1 && rank === 0) {
            rank = 228;
        }
        if (ranks.indexOf('TTT') > -1 && ranks.indexOf('99') > -1 && rank === 0) {
            rank = 227;
        }
        if (ranks.indexOf('TTT') > -1 && ranks.indexOf('88') > -1 && rank === 0) {
            rank = 226;
        }
        if (ranks.indexOf('TTT') > -1 && ranks.indexOf('77') > -1 && rank === 0) {
            rank = 225;
        }
        if (ranks.indexOf('TTT') > -1 && ranks.indexOf('66') > -1 && rank === 0) {
            rank = 224;
        }
        if (ranks.indexOf('TTT') > -1 && ranks.indexOf('55') > -1 && rank === 0) {
            rank = 223;
        }
        if (ranks.indexOf('TTT') > -1 && ranks.indexOf('44') > -1 && rank === 0) {
            rank = 222;
        }
        if (ranks.indexOf('TTT') > -1 && ranks.indexOf('33') > -1 && rank === 0) {
            rank = 221;
        }
        if (ranks.indexOf('TTT') > -1 && ranks.indexOf('22') > -1 && rank === 0) {
            rank = 220;
        }
        if (ranks.indexOf('999') > -1 && ranks.indexOf('AA') > -1 && rank === 0) {
            rank = 219;
        }
        if (ranks.indexOf('999') > -1 && ranks.indexOf('KK') > -1 && rank === 0) {
            rank = 218;
        }
        if (ranks.indexOf('999') > -1 && ranks.indexOf('QQ') > -1 && rank === 0) {
            rank = 217;
        }
        if (ranks.indexOf('999') > -1 && ranks.indexOf('JJ') > -1 && rank === 0) {
            rank = 216;
        }
        if (ranks.indexOf('999') > -1 && ranks.indexOf('TT') > -1 && rank === 0) {
            rank = 215;
        }
        if (ranks.indexOf('999') > -1 && ranks.indexOf('88') > -1 && rank === 0) {
            rank = 214;
        }
        if (ranks.indexOf('999') > -1 && ranks.indexOf('77') > -1 && rank === 0) {
            rank = 213;
        }
        if (ranks.indexOf('999') > -1 && ranks.indexOf('66') > -1 && rank === 0) {
            rank = 212;
        }
        if (ranks.indexOf('999') > -1 && ranks.indexOf('55') > -1 && rank === 0) {
            rank = 211;
        }
        if (ranks.indexOf('999') > -1 && ranks.indexOf('44') > -1 && rank === 0) {
            rank = 210;
        }
        if (ranks.indexOf('999') > -1 && ranks.indexOf('33') > -1 && rank === 0) {
            rank = 209;
        }
        if (ranks.indexOf('999') > -1 && ranks.indexOf('22') > -1 && rank === 0) {
            rank = 208;
        }
        if (ranks.indexOf('888') > -1 && ranks.indexOf('AA') > -1 && rank === 0) {
            rank = 207;
        }
        if (ranks.indexOf('888') > -1 && ranks.indexOf('KK') > -1 && rank === 0) {
            rank = 206;
        }
        if (ranks.indexOf('888') > -1 && ranks.indexOf('QQ') > -1 && rank === 0) {
            rank = 205;
        }
        if (ranks.indexOf('888') > -1 && ranks.indexOf('JJ') > -1 && rank === 0) {
            rank = 204;
        }
        if (ranks.indexOf('888') > -1 && ranks.indexOf('TT') > -1 && rank === 0) {
            rank = 203;
        }
        if (ranks.indexOf('888') > -1 && ranks.indexOf('99') > -1 && rank === 0) {
            rank = 202;
        }
        if (ranks.indexOf('888') > -1 && ranks.indexOf('77') > -1 && rank === 0) {
            rank = 201;
        }
        if (ranks.indexOf('888') > -1 && ranks.indexOf('66') > -1 && rank === 0) {
            rank = 200;
        }
        if (ranks.indexOf('888') > -1 && ranks.indexOf('55') > -1 && rank === 0) {
            rank = 199;
        }
        if (ranks.indexOf('888') > -1 && ranks.indexOf('44') > -1 && rank === 0) {
            rank = 198;
        }
        if (ranks.indexOf('888') > -1 && ranks.indexOf('33') > -1 && rank === 0) {
            rank = 197;
        }
        if (ranks.indexOf('888') > -1 && ranks.indexOf('22') > -1 && rank === 0) {
            rank = 196;
        }
        if (ranks.indexOf('777') > -1 && ranks.indexOf('AA') > -1 && rank === 0) {
            rank = 195;
        }
        if (ranks.indexOf('777') > -1 && ranks.indexOf('KK') > -1 && rank === 0) {
            rank = 194;
        }
        if (ranks.indexOf('777') > -1 && ranks.indexOf('QQ') > -1 && rank === 0) {
            rank = 193;
        }
        if (ranks.indexOf('777') > -1 && ranks.indexOf('JJ') > -1 && rank === 0) {
            rank = 192;
        }
        if (ranks.indexOf('777') > -1 && ranks.indexOf('TT') > -1 && rank === 0) {
            rank = 191;
        }
        if (ranks.indexOf('777') > -1 && ranks.indexOf('99') > -1 && rank === 0) {
            rank = 190;
        }
        if (ranks.indexOf('777') > -1 && ranks.indexOf('88') > -1 && rank === 0) {
            rank = 189;
        }
        if (ranks.indexOf('777') > -1 && ranks.indexOf('66') > -1 && rank === 0) {
            rank = 188;
        }
        if (ranks.indexOf('777') > -1 && ranks.indexOf('55') > -1 && rank === 0) {
            rank = 187;
        }
        if (ranks.indexOf('777') > -1 && ranks.indexOf('44') > -1 && rank === 0) {
            rank = 186;
        }
        if (ranks.indexOf('777') > -1 && ranks.indexOf('33') > -1 && rank === 0) {
            rank = 185;
        }
        if (ranks.indexOf('777') > -1 && ranks.indexOf('22') > -1 && rank === 0) {
            rank = 184;
        }
        if (ranks.indexOf('666') > -1 && ranks.indexOf('AA') > -1 && rank === 0) {
            rank = 183;
        }
        if (ranks.indexOf('666') > -1 && ranks.indexOf('KK') > -1 && rank === 0) {
            rank = 182;
        }
        if (ranks.indexOf('666') > -1 && ranks.indexOf('QQ') > -1 && rank === 0) {
            rank = 181;
        }
        if (ranks.indexOf('666') > -1 && ranks.indexOf('JJ') > -1 && rank === 0) {
            rank = 180;
        }
        if (ranks.indexOf('666') > -1 && ranks.indexOf('TT') > -1 && rank === 0) {
            rank = 179;
        }
        if (ranks.indexOf('666') > -1 && ranks.indexOf('99') > -1 && rank === 0) {
            rank = 178;
        }
        if (ranks.indexOf('666') > -1 && ranks.indexOf('88') > -1 && rank === 0) {
            rank = 177;
        }
        if (ranks.indexOf('666') > -1 && ranks.indexOf('77') > -1 && rank === 0) {
            rank = 176;
        }
        if (ranks.indexOf('666') > -1 && ranks.indexOf('55') > -1 && rank === 0) {
            rank = 175;
        }
        if (ranks.indexOf('666') > -1 && ranks.indexOf('44') > -1 && rank === 0) {
            rank = 174;
        }
        if (ranks.indexOf('666') > -1 && ranks.indexOf('33') > -1 && rank === 0) {
            rank = 173;
        }
        if (ranks.indexOf('666') > -1 && ranks.indexOf('22') > -1 && rank === 0) {
            rank = 172;
        }
        if (ranks.indexOf('555') > -1 && ranks.indexOf('AA') > -1 && rank === 0) {
            rank = 171;
        }
        if (ranks.indexOf('555') > -1 && ranks.indexOf('KK') > -1 && rank === 0) {
            rank = 170;
        }
        if (ranks.indexOf('555') > -1 && ranks.indexOf('QQ') > -1 && rank === 0) {
            rank = 169;
        }
        if (ranks.indexOf('555') > -1 && ranks.indexOf('JJ') > -1 && rank === 0) {
            rank = 168;
        }
        if (ranks.indexOf('555') > -1 && ranks.indexOf('TT') > -1 && rank === 0) {
            rank = 167;
        }
        if (ranks.indexOf('555') > -1 && ranks.indexOf('99') > -1 && rank === 0) {
            rank = 166;
        }
        if (ranks.indexOf('555') > -1 && ranks.indexOf('88') > -1 && rank === 0) {
            rank = 165;
        }
        if (ranks.indexOf('555') > -1 && ranks.indexOf('77') > -1 && rank === 0) {
            rank = 164;
        }
        if (ranks.indexOf('555') > -1 && ranks.indexOf('66') > -1 && rank === 0) {
            rank = 163;
        }
        if (ranks.indexOf('555') > -1 && ranks.indexOf('44') > -1 && rank === 0) {
            rank = 162;
        }
        if (ranks.indexOf('555') > -1 && ranks.indexOf('33') > -1 && rank === 0) {
            rank = 161;
        }
        if (ranks.indexOf('555') > -1 && ranks.indexOf('22') > -1 && rank === 0) {
            rank = 160;
        }
        if (ranks.indexOf('444') > -1 && ranks.indexOf('AA') > -1 && rank === 0) {
            rank = 159;
        }
        if (ranks.indexOf('444') > -1 && ranks.indexOf('KK') > -1 && rank === 0) {
            rank = 158;
        }
        if (ranks.indexOf('444') > -1 && ranks.indexOf('QQ') > -1 && rank === 0) {
            rank = 157;
        }
        if (ranks.indexOf('444') > -1 && ranks.indexOf('JJ') > -1 && rank === 0) {
            rank = 156;
        }
        if (ranks.indexOf('444') > -1 && ranks.indexOf('TT') > -1 && rank === 0) {
            rank = 155;
        }
        if (ranks.indexOf('444') > -1 && ranks.indexOf('99') > -1 && rank === 0) {
            rank = 154;
        }
        if (ranks.indexOf('444') > -1 && ranks.indexOf('88') > -1 && rank === 0) {
            rank = 153;
        }
        if (ranks.indexOf('444') > -1 && ranks.indexOf('77') > -1 && rank === 0) {
            rank = 152;
        }
        if (ranks.indexOf('444') > -1 && ranks.indexOf('66') > -1 && rank === 0) {
            rank = 151;
        }
        if (ranks.indexOf('444') > -1 && ranks.indexOf('55') > -1 && rank === 0) {
            rank = 150;
        }
        if (ranks.indexOf('444') > -1 && ranks.indexOf('33') > -1 && rank === 0) {
            rank = 149;
        }
        if (ranks.indexOf('444') > -1 && ranks.indexOf('22') > -1 && rank === 0) {
            rank = 148;
        }
        if (ranks.indexOf('333') > -1 && ranks.indexOf('AA') > -1 && rank === 0) {
            rank = 147;
        }
        if (ranks.indexOf('333') > -1 && ranks.indexOf('KK') > -1 && rank === 0) {
            rank = 146;
        }
        if (ranks.indexOf('333') > -1 && ranks.indexOf('QQ') > -1 && rank === 0) {
            rank = 145;
        }
        if (ranks.indexOf('333') > -1 && ranks.indexOf('JJ') > -1 && rank === 0) {
            rank = 144;
        }
        if (ranks.indexOf('333') > -1 && ranks.indexOf('TT') > -1 && rank === 0) {
            rank = 143;
        }
        if (ranks.indexOf('333') > -1 && ranks.indexOf('99') > -1 && rank === 0) {
            rank = 142;
        }
        if (ranks.indexOf('333') > -1 && ranks.indexOf('88') > -1 && rank === 0) {
            rank = 141;
        }
        if (ranks.indexOf('333') > -1 && ranks.indexOf('77') > -1 && rank === 0) {
            rank = 140;
        }
        if (ranks.indexOf('333') > -1 && ranks.indexOf('66') > -1 && rank === 0) {
            rank = 139;
        }
        if (ranks.indexOf('333') > -1 && ranks.indexOf('55') > -1 && rank === 0) {
            rank = 138;
        }
        if (ranks.indexOf('333') > -1 && ranks.indexOf('44') > -1 && rank === 0) {
            rank = 137;
        }
        if (ranks.indexOf('333') > -1 && ranks.indexOf('22') > -1 && rank === 0) {
            rank = 136;
        }
        if (ranks.indexOf('222') > -1 && ranks.indexOf('AA') > -1 && rank === 0) {
            rank = 135;
        }
        if (ranks.indexOf('222') > -1 && ranks.indexOf('KK') > -1 && rank === 0) {
            rank = 134;
        }
        if (ranks.indexOf('222') > -1 && ranks.indexOf('QQ') > -1 && rank === 0) {
            rank = 133;
        }
        if (ranks.indexOf('222') > -1 && ranks.indexOf('JJ') > -1 && rank === 0) {
            rank = 132;
        }
        if (ranks.indexOf('222') > -1 && ranks.indexOf('TT') > -1 && rank === 0) {
            rank = 131;
        }
        if (ranks.indexOf('222') > -1 && ranks.indexOf('99') > -1 && rank === 0) {
            rank = 130;
        }
        if (ranks.indexOf('222') > -1 && ranks.indexOf('88') > -1 && rank === 0) {
            rank = 129;
        }
        if (ranks.indexOf('222') > -1 && ranks.indexOf('77') > -1 && rank === 0) {
            rank = 128;
        }
        if (ranks.indexOf('222') > -1 && ranks.indexOf('66') > -1 && rank === 0) {
            rank = 127;
        }
        if (ranks.indexOf('222') > -1 && ranks.indexOf('55') > -1 && rank === 0) {
            rank = 126;
        }
        if (ranks.indexOf('222') > -1 && ranks.indexOf('44') > -1 && rank === 0) {
            rank = 125;
        }
        if (ranks.indexOf('222') > -1 && ranks.indexOf('33') > -1 && rank === 0) {
            rank = 124;
        }
        if (rank !== 0) {
            message = 'Full House';
        }
    }

    // Flush
    if (rank === 0) {
        if (suits.indexOf('CCCCC') > -1 || suits.indexOf('DDDDD') > -1 || suits.indexOf('HHHHH') > -1 || suits.indexOf('SSSSS') > -1) {
            rank = 123;
            message = 'Flush';
        }

        // Straight flush
        if (cards.indexOf('TC') > -1 && cards.indexOf('JC') > -1 && cards.indexOf('QC') > -1 && cards.indexOf('KC') > -1 && cards.indexOf('AC') > -1 && rank === 123) {
            rank = 302;
            message = 'Royal Flush';
        }
        if (cards.indexOf('TD') > -1 && cards.indexOf('JD') > -1 && cards.indexOf('QD') > -1 && cards.indexOf('KD') > -1 && cards.indexOf('AD') > -1 && rank === 123) {
            rank = 302;
            message = 'Royal Flush';
        }
        if (cards.indexOf('TH') > -1 && cards.indexOf('JH') > -1 && cards.indexOf('QH') > -1 && cards.indexOf('KH') > -1 && cards.indexOf('AH') > -1 && rank === 123) {
            rank = 302;
            message = 'Royal Flush';
        }
        if (cards.indexOf('TS') > -1 && cards.indexOf('JS') > -1 && cards.indexOf('QS') > -1 && cards.indexOf('KS') > -1 && cards.indexOf('AS') > -1 && rank === 123) {
            rank = 302;
            message = 'Royal Flush';
        }
        if (cards.indexOf('9C') > -1 && cards.indexOf('TC') > -1 && cards.indexOf('JC') > -1 && cards.indexOf('QC') > -1 && cards.indexOf('KC') > -1 && rank === 123) {
            rank = 301;
            message = 'Straight Flush';
        }
        if (cards.indexOf('9D') > -1 && cards.indexOf('TD') > -1 && cards.indexOf('JD') > -1 && cards.indexOf('QD') > -1 && cards.indexOf('KD') > -1 && rank === 123) {
            rank = 301;
            message = 'Straight Flush';
        }
        if (cards.indexOf('9H') > -1 && cards.indexOf('TH') > -1 && cards.indexOf('JH') > -1 && cards.indexOf('QH') > -1 && cards.indexOf('KH') > -1 && rank === 123) {
            rank = 301;
            message = 'Straight Flush';
        }
        if (cards.indexOf('9S') > -1 && cards.indexOf('TS') > -1 && cards.indexOf('JS') > -1 && cards.indexOf('QS') > -1 && cards.indexOf('KS') > -1 && rank === 123) {
            rank = 301;
            message = 'Straight Flush';
        }
        if (cards.indexOf('8C') > -1 && cards.indexOf('9C') > -1 && cards.indexOf('TC') > -1 && cards.indexOf('JC') > -1 && cards.indexOf('QC') > -1 && rank === 123) {
            rank = 300;
            message = 'Straight Flush';
        }
        if (cards.indexOf('8D') > -1 && cards.indexOf('9D') > -1 && cards.indexOf('TD') > -1 && cards.indexOf('JD') > -1 && cards.indexOf('QD') > -1 && rank === 123) {
            rank = 300;
            message = 'Straight Flush';
        }
        if (cards.indexOf('8H') > -1 && cards.indexOf('9H') > -1 && cards.indexOf('TH') > -1 && cards.indexOf('JH') > -1 && cards.indexOf('QH') > -1 && rank === 123) {
            rank = 300;
            message = 'Straight Flush';
        }
        if (cards.indexOf('8S') > -1 && cards.indexOf('9S') > -1 && cards.indexOf('TS') > -1 && cards.indexOf('JS') > -1 && cards.indexOf('QS') > -1 && rank === 123) {
            rank = 300;
            message = 'Straight Flush';
        }
        if (cards.indexOf('7C') > -1 && cards.indexOf('8C') > -1 && cards.indexOf('9C') > -1 && cards.indexOf('TC') > -1 && cards.indexOf('JC') > -1 && rank === 123) {
            rank = 299;
            message = 'Straight Flush';
        }
        if (cards.indexOf('7D') > -1 && cards.indexOf('8D') > -1 && cards.indexOf('9D') > -1 && cards.indexOf('TD') > -1 && cards.indexOf('JD') > -1 && rank === 123) {
            rank = 299;
            message = 'Straight Flush';
        }
        if (cards.indexOf('7H') > -1 && cards.indexOf('8H') > -1 && cards.indexOf('9H') > -1 && cards.indexOf('TH') > -1 && cards.indexOf('JH') > -1 && rank === 123) {
            rank = 299;
            message = 'Straight Flush';
        }
        if (cards.indexOf('7S') > -1 && cards.indexOf('8S') > -1 && cards.indexOf('9S') > -1 && cards.indexOf('TS') > -1 && cards.indexOf('JS') > -1 && rank === 123) {
            rank = 299;
            message = 'Straight Flush';
        }
        if (cards.indexOf('6C') > -1 && cards.indexOf('7C') > -1 && cards.indexOf('8C') > -1 && cards.indexOf('9C') > -1 && cards.indexOf('TC') > -1 && rank === 123) {
            rank = 298;
            message = 'Straight Flush';
        }
        if (cards.indexOf('6D') > -1 && cards.indexOf('7D') > -1 && cards.indexOf('8D') > -1 && cards.indexOf('9D') > -1 && cards.indexOf('TD') > -1 && rank === 123) {
            rank = 298;
            message = 'Straight Flush';
        }
        if (cards.indexOf('6H') > -1 && cards.indexOf('7H') > -1 && cards.indexOf('8H') > -1 && cards.indexOf('9H') > -1 && cards.indexOf('TH') > -1 && rank === 123) {
            rank = 298;
            message = 'Straight Flush';
        }
        if (cards.indexOf('6S') > -1 && cards.indexOf('7S') > -1 && cards.indexOf('8S') > -1 && cards.indexOf('9S') > -1 && cards.indexOf('TS') > -1 && rank === 123) {
            rank = 298;
            message = 'Straight Flush';
        }
        if (cards.indexOf('5C') > -1 && cards.indexOf('6C') > -1 && cards.indexOf('7C') > -1 && cards.indexOf('8C') > -1 && cards.indexOf('9C') > -1 && rank === 123) {
            rank = 297;
            message = 'Straight Flush';
        }
        if (cards.indexOf('5D') > -1 && cards.indexOf('6D') > -1 && cards.indexOf('7D') > -1 && cards.indexOf('8D') > -1 && cards.indexOf('9D') > -1 && rank === 123) {
            rank = 297;
            message = 'Straight Flush';
        }
        if (cards.indexOf('5H') > -1 && cards.indexOf('6H') > -1 && cards.indexOf('7H') > -1 && cards.indexOf('8H') > -1 && cards.indexOf('9H') > -1 && rank === 123) {
            rank = 297;
            message = 'Straight Flush';
        }
        if (cards.indexOf('5S') > -1 && cards.indexOf('6S') > -1 && cards.indexOf('7S') > -1 && cards.indexOf('8S') > -1 && cards.indexOf('9S') > -1 && rank === 123) {
            rank = 297;
            message = 'Straight Flush';
        }
        if (cards.indexOf('4C') > -1 && cards.indexOf('5C') > -1 && cards.indexOf('6C') > -1 && cards.indexOf('7C') > -1 && cards.indexOf('8C') > -1 && rank === 123) {
            rank = 296;
            message = 'Straight Flush';
        }
        if (cards.indexOf('4D') > -1 && cards.indexOf('5D') > -1 && cards.indexOf('6D') > -1 && cards.indexOf('7D') > -1 && cards.indexOf('8D') > -1 && rank === 123) {
            rank = 296;
            message = 'Straight Flush';
        }
        if (cards.indexOf('4H') > -1 && cards.indexOf('5H') > -1 && cards.indexOf('6H') > -1 && cards.indexOf('7H') > -1 && cards.indexOf('8H') > -1 && rank === 123) {
            rank = 296;
            message = 'Straight Flush';
        }
        if (cards.indexOf('4S') > -1 && cards.indexOf('5S') > -1 && cards.indexOf('6S') > -1 && cards.indexOf('7S') > -1 && cards.indexOf('8S') > -1 && rank === 123) {
            rank = 296;
            message = 'Straight Flush';
        }
        if (cards.indexOf('3C') > -1 && cards.indexOf('4C') > -1 && cards.indexOf('5C') > -1 && cards.indexOf('6C') > -1 && cards.indexOf('7C') > -1 && rank === 123) {
            rank = 295;
            message = 'Straight Flush';
        }
        if (cards.indexOf('3D') > -1 && cards.indexOf('4D') > -1 && cards.indexOf('5D') > -1 && cards.indexOf('6D') > -1 && cards.indexOf('7D') > -1 && rank === 123) {
            rank = 295;
            message = 'Straight Flush';
        }
        if (cards.indexOf('3H') > -1 && cards.indexOf('4H') > -1 && cards.indexOf('5H') > -1 && cards.indexOf('6H') > -1 && cards.indexOf('7H') > -1 && rank === 123) {
            rank = 295;
            message = 'Straight Flush';
        }
        if (cards.indexOf('3S') > -1 && cards.indexOf('4S') > -1 && cards.indexOf('5S') > -1 && cards.indexOf('6S') > -1 && cards.indexOf('7S') > -1 && rank === 123) {
            rank = 295;
            message = 'Straight Flush';
        }
        if (cards.indexOf('2C') > -1 && cards.indexOf('3C') > -1 && cards.indexOf('4C') > -1 && cards.indexOf('5C') > -1 && cards.indexOf('6C') > -1 && rank === 123) {
            rank = 294;
            message = 'Straight Flush';
        }
        if (cards.indexOf('2D') > -1 && cards.indexOf('3D') > -1 && cards.indexOf('4D') > -1 && cards.indexOf('5D') > -1 && cards.indexOf('6D') > -1 && rank === 123) {
            rank = 294;
            message = 'Straight Flush';
        }
        if (cards.indexOf('2H') > -1 && cards.indexOf('3H') > -1 && cards.indexOf('4H') > -1 && cards.indexOf('5H') > -1 && cards.indexOf('6H') > -1 && rank === 123) {
            rank = 294;
            message = 'Straight Flush';
        }
        if (cards.indexOf('2S') > -1 && cards.indexOf('3S') > -1 && cards.indexOf('4S') > -1 && cards.indexOf('5S') > -1 && cards.indexOf('6S') > -1 && rank === 123) {
            rank = 294;
            message = 'Straight Flush';
        }
        if (cards.indexOf('AC') > -1 && cards.indexOf('2C') > -1 && cards.indexOf('3C') > -1 && cards.indexOf('4C') > -1 && cards.indexOf('5C') > -1 && rank === 123) {
            rank = 293;
            message = 'Straight Flush';
        }
        if (cards.indexOf('AS') > -1 && cards.indexOf('2S') > -1 && cards.indexOf('3S') > -1 && cards.indexOf('4S') > -1 && cards.indexOf('5S') > -1 && rank === 123) {
            rank = 293;
            message = 'Straight Flush';
        }
        if (cards.indexOf('AH') > -1 && cards.indexOf('2H') > -1 && cards.indexOf('3H') > -1 && cards.indexOf('4H') > -1 && cards.indexOf('5H') > -1 && rank === 123) {
            rank = 293;
            message = 'Straight Flush';
        }
        if (cards.indexOf('AD') > -1 && cards.indexOf('2D') > -1 && cards.indexOf('3D') > -1 && cards.indexOf('4D') > -1 && cards.indexOf('5D') > -1 && rank === 123) {
            rank = 293;
            message = 'Straight Flush';
        }
        if (rank === 123) {
            rank = rank + rankKickers(ranks, 5);
        }

    }

    // Straight
    if (rank === 0) {
        if (cards.indexOf('T') > -1 && cards.indexOf('J') > -1 && cards.indexOf('Q') > -1 && cards.indexOf('K') > -1 && cards.indexOf('A') > -1) {
            rank = 122;
        }
        if (cards.indexOf('9') > -1 && cards.indexOf('T') > -1 && cards.indexOf('J') > -1 && cards.indexOf('Q') > -1 && cards.indexOf('K') > -1 && rank === 0) {
            rank = 121;
        }
        if (cards.indexOf('8') > -1 && cards.indexOf('9') > -1 && cards.indexOf('T') > -1 && cards.indexOf('J') > -1 && cards.indexOf('Q') > -1 && rank === 0) {
            rank = 120;
        }
        if (cards.indexOf('7') > -1 && cards.indexOf('8') > -1 && cards.indexOf('9') > -1 && cards.indexOf('T') > -1 && cards.indexOf('J') > -1 && rank === 0) {
            rank = 119;
        }
        if (cards.indexOf('6') > -1 && cards.indexOf('7') > -1 && cards.indexOf('8') > -1 && cards.indexOf('9') > -1 && cards.indexOf('T') > -1 && rank === 0) {
            rank = 118;
        }
        if (cards.indexOf('5') > -1 && cards.indexOf('6') > -1 && cards.indexOf('7') > -1 && cards.indexOf('8') > -1 && cards.indexOf('9') > -1 && rank === 0) {
            rank = 117;
        }
        if (cards.indexOf('4') > -1 && cards.indexOf('5') > -1 && cards.indexOf('6') > -1 && cards.indexOf('7') > -1 && cards.indexOf('8') > -1 && rank === 0) {
            rank = 116;
        }
        if (cards.indexOf('3') > -1 && cards.indexOf('4') > -1 && cards.indexOf('5') > -1 && cards.indexOf('6') > -1 && cards.indexOf('7') > -1 && rank === 0) {
            rank = 115;
        }
        if (cards.indexOf('2') > -1 && cards.indexOf('3') > -1 && cards.indexOf('4') > -1 && cards.indexOf('5') > -1 && cards.indexOf('6') > -1 && rank === 0) {
            rank = 114;
        }
        if (cards.indexOf('A') > -1 && cards.indexOf('2') > -1 && cards.indexOf('3') > -1 && cards.indexOf('4') > -1 && cards.indexOf('5') > -1 && rank === 0) {
            rank = 113;
        }
        if (rank !== 0) {
            message = 'Straight';
        }
    }

    // Three of a kind
    if (rank === 0) {
        if (ranks.indexOf('AAA') > -1) {
            rank = 112 + rankKickers(ranks.replace('AAA', ''), 2);
        }
        if (ranks.indexOf('KKK') > -1 && rank === 0) {
            rank = 111 + rankKickers(ranks.replace('KKK', ''), 2);
        }
        if (ranks.indexOf('QQQ') > -1 && rank === 0) {
            rank = 110 + rankKickers(ranks.replace('QQQ', ''), 2);
        }
        if (ranks.indexOf('JJJ') > -1 && rank === 0) {
            rank = 109 + rankKickers(ranks.replace('JJJ', ''), 2);
        }
        if (ranks.indexOf('TTT') > -1 && rank === 0) {
            rank = 108 + rankKickers(ranks.replace('TTT', ''), 2);
        }
        if (ranks.indexOf('999') > -1 && rank === 0) {
            rank = 107 + rankKickers(ranks.replace('999', ''), 2);
        }
        if (ranks.indexOf('888') > -1 && rank === 0) {
            rank = 106 + rankKickers(ranks.replace('888', ''), 2);
        }
        if (ranks.indexOf('777') > -1 && rank === 0) {
            rank = 105 + rankKickers(ranks.replace('777', ''), 2);
        }
        if (ranks.indexOf('666') > -1 && rank === 0) {
            rank = 104 + rankKickers(ranks.replace('666', ''), 2);
        }
        if (ranks.indexOf('555') > -1 && rank === 0) {
            rank = 103 + rankKickers(ranks.replace('555', ''), 2);
        }
        if (ranks.indexOf('444') > -1 && rank === 0) {
            rank = 102 + rankKickers(ranks.replace('444', ''), 2);
        }
        if (ranks.indexOf('333') > -1 && rank === 0) {
            rank = 101 + rankKickers(ranks.replace('333', ''), 2);
        }
        if (ranks.indexOf('222') > -1 && rank === 0) {
            rank = 100 + rankKickers(ranks.replace('222', ''), 2);
        }
        if (rank !== 0) {
            message = 'Three of a Kind';
        }
    }

    // Two pair
    if (rank === 0) {
        if (ranks.indexOf('AA') > -1 && ranks.indexOf('KK') > -1) {
            rank = 99 + rankKickers(ranks.replace('AA', '').replace('KK', ''), 1);
        }
        if (ranks.indexOf('AA') > -1 && ranks.indexOf('QQ') > -1 && rank === 0) {
            rank = 98 + rankKickers(ranks.replace('AA', '').replace('QQ', ''), 1);
        }
        if (ranks.indexOf('AA') > -1 && ranks.indexOf('JJ') > -1 && rank === 0) {
            rank = 97 + rankKickers(ranks.replace('AA', '').replace('JJ', ''), 1);
        }
        if (ranks.indexOf('AA') > -1 && ranks.indexOf('TT') > -1 && rank === 0) {
            rank = 96 + rankKickers(ranks.replace('AA', '').replace('TT', ''), 1);
        }
        if (ranks.indexOf('AA') > -1 && ranks.indexOf('99') > -1 && rank === 0) {
            rank = 95 + rankKickers(ranks.replace('AA', '').replace('99', ''), 1);
        }
        if (ranks.indexOf('AA') > -1 && ranks.indexOf('88') > -1 && rank === 0) {
            rank = 94 + rankKickers(ranks.replace('AA', '').replace('88', ''), 1);
        }
        if (ranks.indexOf('AA') > -1 && ranks.indexOf('77') > -1 && rank === 0) {
            rank = 93 + rankKickers(ranks.replace('AA', '').replace('77', ''), 1);
        }
        if (ranks.indexOf('AA') > -1 && ranks.indexOf('66') > -1 && rank === 0) {
            rank = 92 + rankKickers(ranks.replace('AA', '').replace('66', ''), 1);
        }
        if (ranks.indexOf('AA') > -1 && ranks.indexOf('55') > -1 && rank === 0) {
            rank = 91 + rankKickers(ranks.replace('AA', '').replace('55', ''), 1);
        }
        if (ranks.indexOf('AA') > -1 && ranks.indexOf('44') > -1 && rank === 0) {
            rank = 90 + rankKickers(ranks.replace('AA', '').replace('44', ''), 1);
        }
        if (ranks.indexOf('AA') > -1 && ranks.indexOf('33') > -1 && rank === 0) {
            rank = 89 + rankKickers(ranks.replace('AA', '').replace('33', ''), 1);
        }
        if (ranks.indexOf('AA') > -1 && ranks.indexOf('22') > -1 && rank === 0) {
            rank = 88 + rankKickers(ranks.replace('AA', '').replace('22', ''), 1);
        }
        if (ranks.indexOf('KK') > -1 && ranks.indexOf('QQ') > -1 && rank === 0) {
            rank = 87 + rankKickers(ranks.replace('KK', '').replace('QQ', ''), 1);
        }
        if (ranks.indexOf('KK') > -1 && ranks.indexOf('JJ') > -1 && rank === 0) {
            rank = 86 + rankKickers(ranks.replace('KK', '').replace('JJ', ''), 1);
        }
        if (ranks.indexOf('KK') > -1 && ranks.indexOf('TT') > -1 && rank === 0) {
            rank = 85 + rankKickers(ranks.replace('KK', '').replace('TT', ''), 1);
        }
        if (ranks.indexOf('KK') > -1 && ranks.indexOf('99') > -1 && rank === 0) {
            rank = 84 + rankKickers(ranks.replace('KK', '').replace('99', ''), 1);
        }
        if (ranks.indexOf('KK') > -1 && ranks.indexOf('88') > -1 && rank === 0) {
            rank = 83 + rankKickers(ranks.replace('KK', '').replace('88', ''), 1);
        }
        if (ranks.indexOf('KK') > -1 && ranks.indexOf('77') > -1 && rank === 0) {
            rank = 82 + rankKickers(ranks.replace('KK', '').replace('77', ''), 1);
        }
        if (ranks.indexOf('KK') > -1 && ranks.indexOf('66') > -1 && rank === 0) {
            rank = 81 + rankKickers(ranks.replace('KK', '').replace('66', ''), 1);
        }
        if (ranks.indexOf('KK') > -1 && ranks.indexOf('55') > -1 && rank === 0) {
            rank = 80 + rankKickers(ranks.replace('KK', '').replace('55', ''), 1);
        }
        if (ranks.indexOf('KK') > -1 && ranks.indexOf('44') > -1 && rank === 0) {
            rank = 79 + rankKickers(ranks.replace('KK', '').replace('44', ''), 1);
        }
        if (ranks.indexOf('KK') > -1 && ranks.indexOf('33') > -1 && rank === 0) {
            rank = 78 + rankKickers(ranks.replace('KK', '').replace('33', ''), 1);
        }
        if (ranks.indexOf('KK') > -1 && ranks.indexOf('22') > -1 && rank === 0) {
            rank = 77 + rankKickers(ranks.replace('KK', '').replace('22', ''), 1);
        }
        if (ranks.indexOf('QQ') > -1 && ranks.indexOf('JJ') > -1 && rank === 0) {
            rank = 76 + rankKickers(ranks.replace('QQ', '').replace('JJ', ''), 1);
        }
        if (ranks.indexOf('QQ') > -1 && ranks.indexOf('TT') > -1 && rank === 0) {
            rank = 75 + rankKickers(ranks.replace('QQ', '').replace('TT', ''), 1);
        }
        if (ranks.indexOf('QQ') > -1 && ranks.indexOf('99') > -1 && rank === 0) {
            rank = 74 + rankKickers(ranks.replace('QQ', '').replace('99', ''), 1);
        }
        if (ranks.indexOf('QQ') > -1 && ranks.indexOf('88') > -1 && rank === 0) {
            rank = 73 + rankKickers(ranks.replace('QQ', '').replace('88', ''), 1);
        }
        if (ranks.indexOf('QQ') > -1 && ranks.indexOf('77') > -1 && rank === 0) {
            rank = 72 + rankKickers(ranks.replace('QQ', '').replace('77', ''), 1);
        }
        if (ranks.indexOf('QQ') > -1 && ranks.indexOf('66') > -1 && rank === 0) {
            rank = 71 + rankKickers(ranks.replace('QQ', '').replace('66', ''), 1);
        }
        if (ranks.indexOf('QQ') > -1 && ranks.indexOf('55') > -1 && rank === 0) {
            rank = 70 + rankKickers(ranks.replace('QQ', '').replace('55', ''), 1);
        }
        if (ranks.indexOf('QQ') > -1 && ranks.indexOf('44') > -1 && rank === 0) {
            rank = 69 + rankKickers(ranks.replace('QQ', '').replace('44', ''), 1);
        }
        if (ranks.indexOf('QQ') > -1 && ranks.indexOf('33') > -1 && rank === 0) {
            rank = 68 + rankKickers(ranks.replace('QQ', '').replace('33', ''), 1);
        }
        if (ranks.indexOf('QQ') > -1 && ranks.indexOf('22') > -1 && rank === 0) {
            rank = 67 + rankKickers(ranks.replace('QQ', '').replace('22', ''), 1);
        }
        if (ranks.indexOf('JJ') > -1 && ranks.indexOf('TT') > -1 && rank === 0) {
            rank = 66 + rankKickers(ranks.replace('JJ', '').replace('TT', ''), 1);
        }
        if (ranks.indexOf('JJ') > -1 && ranks.indexOf('99') > -1 && rank === 0) {
            rank = 65 + rankKickers(ranks.replace('JJ', '').replace('99', ''), 1);
        }
        if (ranks.indexOf('JJ') > -1 && ranks.indexOf('88') > -1 && rank === 0) {
            rank = 64 + rankKickers(ranks.replace('JJ', '').replace('88', ''), 1);
        }
        if (ranks.indexOf('JJ') > -1 && ranks.indexOf('77') > -1 && rank === 0) {
            rank = 63 + rankKickers(ranks.replace('JJ', '').replace('77', ''), 1);
        }
        if (ranks.indexOf('JJ') > -1 && ranks.indexOf('66') > -1 && rank === 0) {
            rank = 62 + rankKickers(ranks.replace('JJ', '').replace('66', ''), 1);
        }
        if (ranks.indexOf('JJ') > -1 && ranks.indexOf('55') > -1 && rank === 0) {
            rank = 61 + rankKickers(ranks.replace('JJ', '').replace('55', ''), 1);
        }
        if (ranks.indexOf('JJ') > -1 && ranks.indexOf('44') > -1 && rank === 0) {
            rank = 60 + rankKickers(ranks.replace('JJ', '').replace('44', ''), 1);
        }
        if (ranks.indexOf('JJ') > -1 && ranks.indexOf('33') > -1 && rank === 0) {
            rank = 59 + rankKickers(ranks.replace('JJ', '').replace('33', ''), 1);
        }
        if (ranks.indexOf('JJ') > -1 && ranks.indexOf('22') > -1 && rank === 0) {
            rank = 58 + rankKickers(ranks.replace('JJ', '').replace('22', ''), 1);
        }
        if (ranks.indexOf('TT') > -1 && ranks.indexOf('99') > -1 && rank === 0) {
            rank = 57 + rankKickers(ranks.replace('TT', '').replace('99', ''), 1);
        }
        if (ranks.indexOf('TT') > -1 && ranks.indexOf('88') > -1 && rank === 0) {
            rank = 56 + rankKickers(ranks.replace('TT', '').replace('88', ''), 1);
        }
        if (ranks.indexOf('TT') > -1 && ranks.indexOf('77') > -1 && rank === 0) {
            rank = 55 + rankKickers(ranks.replace('TT', '').replace('77', ''), 1);
        }
        if (ranks.indexOf('TT') > -1 && ranks.indexOf('66') > -1 && rank === 0) {
            rank = 54 + rankKickers(ranks.replace('TT', '').replace('66', ''), 1);
        }
        if (ranks.indexOf('TT') > -1 && ranks.indexOf('55') > -1 && rank === 0) {
            rank = 53 + rankKickers(ranks.replace('TT', '').replace('55', ''), 1);
        }
        if (ranks.indexOf('TT') > -1 && ranks.indexOf('44') > -1 && rank === 0) {
            rank = 52 + rankKickers(ranks.replace('TT', '').replace('44', ''), 1);
        }
        if (ranks.indexOf('TT') > -1 && ranks.indexOf('33') > -1 && rank === 0) {
            rank = 51 + rankKickers(ranks.replace('TT', '').replace('33', ''), 1);
        }
        if (ranks.indexOf('TT') > -1 && ranks.indexOf('22') > -1 && rank === 0) {
            rank = 50 + rankKickers(ranks.replace('TT', '').replace('22', ''), 1);
        }
        if (ranks.indexOf('99') > -1 && ranks.indexOf('88') > -1 && rank === 0) {
            rank = 49 + rankKickers(ranks.replace('99', '').replace('88', ''), 1);
        }
        if (ranks.indexOf('99') > -1 && ranks.indexOf('77') > -1 && rank === 0) {
            rank = 48 + rankKickers(ranks.replace('99', '').replace('77', ''), 1);
        }
        if (ranks.indexOf('99') > -1 && ranks.indexOf('66') > -1 && rank === 0) {
            rank = 47 + rankKickers(ranks.replace('99', '').replace('66', ''), 1);
        }
        if (ranks.indexOf('99') > -1 && ranks.indexOf('55') > -1 && rank === 0) {
            rank = 46 + rankKickers(ranks.replace('99', '').replace('55', ''), 1);
        }
        if (ranks.indexOf('99') > -1 && ranks.indexOf('44') > -1 && rank === 0) {
            rank = 45 + rankKickers(ranks.replace('99', '').replace('44', ''), 1);
        }
        if (ranks.indexOf('99') > -1 && ranks.indexOf('33') > -1 && rank === 0) {
            rank = 44 + rankKickers(ranks.replace('99', '').replace('33', ''), 1);
        }
        if (ranks.indexOf('99') > -1 && ranks.indexOf('22') > -1 && rank === 0) {
            rank = 43 + rankKickers(ranks.replace('99', '').replace('22', ''), 1);
        }
        if (ranks.indexOf('88') > -1 && ranks.indexOf('77') > -1 && rank === 0) {
            rank = 42 + rankKickers(ranks.replace('88', '').replace('77', ''), 1);
        }
        if (ranks.indexOf('88') > -1 && ranks.indexOf('66') > -1 && rank === 0) {
            rank = 41 + rankKickers(ranks.replace('88', '').replace('66', ''), 1);
        }
        if (ranks.indexOf('88') > -1 && ranks.indexOf('55') > -1 && rank === 0) {
            rank = 40 + rankKickers(ranks.replace('88', '').replace('55', ''), 1);
        }
        if (ranks.indexOf('88') > -1 && ranks.indexOf('44') > -1 && rank === 0) {
            rank = 39 + rankKickers(ranks.replace('88', '').replace('44', ''), 1);
        }
        if (ranks.indexOf('88') > -1 && ranks.indexOf('33') > -1 && rank === 0) {
            rank = 38 + rankKickers(ranks.replace('88', '').replace('33', ''), 1);
        }
        if (ranks.indexOf('88') > -1 && ranks.indexOf('22') > -1 && rank === 0) {
            rank = 37 + rankKickers(ranks.replace('88', '').replace('22', ''), 1);
        }
        if (ranks.indexOf('77') > -1 && ranks.indexOf('66') > -1 && rank === 0) {
            rank = 36 + rankKickers(ranks.replace('77', '').replace('66', ''), 1);
        }
        if (ranks.indexOf('77') > -1 && ranks.indexOf('55') > -1 && rank === 0) {
            rank = 35 + rankKickers(ranks.replace('77', '').replace('55', ''), 1);
        }
        if (ranks.indexOf('77') > -1 && ranks.indexOf('44') > -1 && rank === 0) {
            rank = 34 + rankKickers(ranks.replace('77', '').replace('44', ''), 1);
        }
        if (ranks.indexOf('77') > -1 && ranks.indexOf('33') > -1 && rank === 0) {
            rank = 33 + rankKickers(ranks.replace('77', '').replace('33', ''), 1);
        }
        if (ranks.indexOf('77') > -1 && ranks.indexOf('22') > -1 && rank === 0) {
            rank = 32 + rankKickers(ranks.replace('77', '').replace('22', ''), 1);
        }
        if (ranks.indexOf('66') > -1 && ranks.indexOf('55') > -1 && rank === 0) {
            rank = 31 + rankKickers(ranks.replace('66', '').replace('55', ''), 1);
        }
        if (ranks.indexOf('66') > -1 && ranks.indexOf('44') > -1 && rank === 0) {
            rank = 30 + rankKickers(ranks.replace('66', '').replace('44', ''), 1);
        }
        if (ranks.indexOf('66') > -1 && ranks.indexOf('33') > -1 && rank === 0) {
            rank = 29 + rankKickers(ranks.replace('66', '').replace('33', ''), 1);
        }
        if (ranks.indexOf('66') > -1 && ranks.indexOf('22') > -1 && rank === 0) {
            rank = 28 + rankKickers(ranks.replace('66', '').replace('22', ''), 1);
        }
        if (ranks.indexOf('55') > -1 && ranks.indexOf('44') > -1 && rank === 0) {
            rank = 27 + rankKickers(ranks.replace('55', '').replace('44', ''), 1);
        }
        if (ranks.indexOf('55') > -1 && ranks.indexOf('33') > -1 && rank === 0) {
            rank = 26 + rankKickers(ranks.replace('55', '').replace('33', ''), 1);
        }
        if (ranks.indexOf('55') > -1 && ranks.indexOf('22') > -1 && rank === 0) {
            rank = 25 + rankKickers(ranks.replace('55', '').replace('22', ''), 1);
        }
        if (ranks.indexOf('44') > -1 && ranks.indexOf('33') > -1 && rank === 0) {
            rank = 24 + rankKickers(ranks.replace('44', '').replace('33', ''), 1);
        }
        if (ranks.indexOf('44') > -1 && ranks.indexOf('22') > -1 && rank === 0) {
            rank = 23 + rankKickers(ranks.replace('44', '').replace('22', ''), 1);
        }
        if (ranks.indexOf('33') > -1 && ranks.indexOf('22') > -1 && rank === 0) {
            rank = 22 + rankKickers(ranks.replace('33', '').replace('22', ''), 1);
        }
        if (rank !== 0) {
            message = 'Two Pair';
        }
    }

    // One Pair
    if (rank === 0) {
        if (ranks.indexOf('AA') > -1) {
            rank = 21 + rankKickers(ranks.replace('AA', ''), 3);
        }
        if (ranks.indexOf('KK') > -1 && rank === 0) {
            rank = 20 + rankKickers(ranks.replace('KK', ''), 3);
        }
        if (ranks.indexOf('QQ') > -1 && rank === 0) {
            rank = 19 + rankKickers(ranks.replace('QQ', ''), 3);
        }
        if (ranks.indexOf('JJ') > -1 && rank === 0) {
            rank = 18 + rankKickers(ranks.replace('JJ', ''), 3);
        }
        if (ranks.indexOf('TT') > -1 && rank === 0) {
            rank = 17 + rankKickers(ranks.replace('TT', ''), 3);
        }
        if (ranks.indexOf('99') > -1 && rank === 0) {
            rank = 16 + rankKickers(ranks.replace('99', ''), 3);
        }
        if (ranks.indexOf('88') > -1 && rank === 0) {
            rank = 15 + rankKickers(ranks.replace('88', ''), 3);
        }
        if (ranks.indexOf('77') > -1 && rank === 0) {
            rank = 14 + rankKickers(ranks.replace('77', ''), 3);
        }
        if (ranks.indexOf('66') > -1 && rank === 0) {
            rank = 13 + rankKickers(ranks.replace('66', ''), 3);
        }
        if (ranks.indexOf('55') > -1 && rank === 0) {
            rank = 12 + rankKickers(ranks.replace('55', ''), 3);
        }
        if (ranks.indexOf('44') > -1 && rank === 0) {
            rank = 11 + rankKickers(ranks.replace('44', ''), 3);
        }
        if (ranks.indexOf('33') > -1 && rank === 0) {
            rank = 10 + rankKickers(ranks.replace('33', ''), 3);
        }
        if (ranks.indexOf('22') > -1 && rank === 0) {
            rank = 9 + rankKickers(ranks.replace('22', ''), 3);
        }
        if (rank !== 0) {
            message = 'Pair';
        }
    }

    // High Card
    if (rank === 0) {
        if (ranks.indexOf('A') > -1) {
            rank = 8 + rankKickers(ranks.replace('A', ''), 4);
        }
        if (ranks.indexOf('K') > -1 && rank === 0) {
            rank = 7 + rankKickers(ranks.replace('K', ''), 4);
        }
        if (ranks.indexOf('Q') > -1 && rank === 0) {
            rank = 6 + rankKickers(ranks.replace('Q', ''), 4);
        }
        if (ranks.indexOf('J') > -1 && rank === 0) {
            rank = 5 + rankKickers(ranks.replace('J', ''), 4);
        }
        if (ranks.indexOf('T') > -1 && rank === 0) {
            rank = 4 + rankKickers(ranks.replace('T', ''), 4);
        }
        if (ranks.indexOf('9') > -1 && rank === 0) {
            rank = 3 + rankKickers(ranks.replace('9', ''), 4);
        }
        if (ranks.indexOf('8') > -1 && rank === 0) {
            rank = 2 + rankKickers(ranks.replace('8', ''), 4);
        }
        if (ranks.indexOf('7') > -1 && rank === 0) {
            rank = 1 + rankKickers(ranks.replace('7', ''), 4);
        }
        if (rank !== 0) {
            message = 'High Card';
        }
    }

    result = new Result(rank, message);

    return result;
}

function rankHand(hand) {
    var myResult = rankHandInt(hand);
    hand.rank = myResult.rank;
    hand.message = myResult.message;

    return hand;
}

function progress(table) {
    var i, j, cards, hand;
    var maxBet;
    maxBet = getMaxBet(table.game.bets);
    table.isActionTime = false;
    if (table.game && table.status == enums.GAME_STATUS_RUNNING) {
        if (checkForEndOfRound(table, maxBet) === true) {
            // Move all bets to the pot
            for (i = 0; i < table.game.bets.length; i += 1) {
                table.game.pot += parseInt(table.game.bets[i], 10);
                logGame(table.tableNumber, 'bets[' + i + '] = ' + table.game.bets[i]);
                table.game.roundBets[i] += table.game.bets[i];

            }
            if (table.game.roundName === 'River') {
                table.game.roundName = 'Showdown';
                table.game.bets.splice(0, table.game.bets.length);
                // Evaluate each hand
                for (j = 0; j < table.players.length; j += 1) {
                    cards = table.players[j].cards.concat(table.game.board);
                    hand = new Hand(cards);
                    table.players[j].hand = rankHand(hand);
                }
                checkForWinner(table);
                /*
                 checkForBankrupt(table);
                 */
                table.eventEmitter.emit('roundEnd');
            } else if (table.game.roundName === 'Turn') {
                logGame(table.tableNumber, 'effective turn -> river');
                table.game.roundName = 'River';
                table.game.deck.pop(); // Burn a card
                table.game.board.push(table.game.deck.pop()); // Turn a card
                /*
                 table.game.bets.splice(0, table.game.bets.length - 1);
                 */
                for (i = 0; i < table.game.bets.length; i += 1) {
                    table.game.bets[i] = 0;
                }
                for (i = 0; i < table.players.length; i += 1) {
                    table.players[i].talked = false;
                }
                table.eventEmitter.emit('deal');
            } else if (table.game.roundName === 'Flop') {
                logGame(table.tableNumber, 'effective flop -> turn');
                table.game.roundName = 'Turn';
                table.game.deck.pop(); // Burn a card
                table.game.board.push(table.game.deck.pop()); // Turn a card
                for (i = 0; i < table.game.bets.length; i += 1) {
                    table.game.bets[i] = 0;
                }
                for (i = 0; i < table.players.length; i += 1) {
                    table.players[i].talked = false;
                }
                table.eventEmitter.emit('deal');
            } else if (table.game.roundName === 'Deal') {
                logGame(table.tableNumber, 'effective deal -> flop');
                table.game.roundName = 'Flop';
                table.game.deck.pop(); // Burn a card
                for (i = 0; i < 3; i += 1) { // Turn three cards
                    table.game.board.push(table.game.deck.pop());
                }
                /*
                 table.game.bets.splice(0,table.game.bets.length - 1);
                 */
                for (i = 0; i < table.game.bets.length; i += 1) {
                    table.game.bets[i] = 0;
                }
                for (i = 0; i < table.players.length; i += 1) {
                    table.players[i].talked = false;
                }
                table.eventEmitter.emit('deal');
            }
        } else {
            getNextPlayer(table);
            if (table.surviveCount === 1 && table.game.bets[table.currentPlayer] >= maxBet) {
                //fix bug: when allinValue < maxBet and other player all fold will cause money divide problem, at this
                //situation the last player should not fold, so we have player default action call
                table.players[table.currentPlayer].Call();
            } else if (table.isBet)
                takeAction(table, '__bet');
            else
                takeAction(table, '__turn');
        }
    }
}

function Game(smallBlind, bigBlind) {
    this.smallBlind = smallBlind;
    this.bigBlind = bigBlind;
    this.pot = 0;
    this.roundName = 'Deal'; // Start the first round
    this.betName = 'bet'; // Bet, raise, re-raise, cap
    this.bets = [];
    this.roundBets = [];
    this.deck = [];
    this.board = [];
    fillDeck(this.deck);
}

/*
 * Helper Methods Public
 */
Table.prototype.getHandForPlayerName = function (playerName) {
    for (var i in this.players) {
        if (this.players[i].playerName === playerName) {
            return this.players[i].cards;
        }
    }
    return [];
};

Table.prototype.getDeal = function () {
    return this.game.board;
};

Table.prototype.getEventEmitter = function () {
    return this.eventEmitter;
};

Table.prototype.getCurrentPlayer = function () {
    return this.players[this.currentPlayer].playerName;
};

Table.prototype.getPreviousPlayerAction = function () {
    return this.turnBet;
};

// Player actions: Check(), Fold(), Bet(bet), Call(), AllIn()

Table.prototype.getWinners = function () {
    return this.gameWinners;
};

Table.prototype.getLosers = function () {
    return this.gameLosers;
};

Table.prototype.getAllHands = function () {
    var all = this.losers.concat(this.players);
    var allHands = [];
    for (var i in all) {
        allHands.push({
            playerName: all[i].playerName,
            chips: all[i].chips,
            hand: all[i].cards,
        });
    }
    return allHands;
};

/*
 Table.prototype.initNewRound = function () {
 var i;
 this.dealer += 1;
 if (this.dealer >= this.players.length) {
 this.dealer = 0;
 }
 this.game.pot = 0;
 this.game.roundName = 'Deal'; // Start the first round
 this.game.betName = 'bet'; // bet, raise, re-raise, cap
 this.game.bets.splice(0, this.game.bets.length);
 this.game.deck.splice(0, this.game.deck.length);
 this.game.board.splice(0, this.game.board.length);
 for (i = 0; i < this.players.length; i += 1) {
 this.players[i].folded = false;
 this.players[i].talked = false;
 this.players[i].allIn = false;
 this.players[i].cards.splice(0, this.players[i].cards.length);
 }
 fillDeck(this.game.deck);
 this.NewRound();
 };
 */

Table.prototype.StartGame = function () {
    // If there is no current game and we have enough players, start a new game.
    console.log('start game');
    if (!this.game) {
        this.playersToRemove = [];
        this.dealer = parseInt(Math.random() * (this.surviveCount));
        this.firstDealer = this.dealer;
        this.status = enums.GAME_STATUS_RUNNING;
        this.game = new Game(this.smallBlind, this.bigBlind);
        this.NewRound();
    }
};

Table.prototype.StopGame = function () {
    console.log('stop game');
    if (!this.game) {
        // TODO: to implement a status for game PAUSED
        this.status = enums.GAME_STATUS_STANDBY;
    }
};

Table.prototype.AddPlayer = function (playerName) {
    var that = this;
    var player = new Player(playerName, that.initChips, this, true, 0);
    this.playersToAdd.push(player);
    this.surviveCount++;
};

Table.prototype.removePlayer = function (playerName) {
    for (var i in this.players) {
        if (this.players[i].playerName === playerName) {
            this.playersToRemove.push(i);
            this.players[i].Fold();
        }
    }
    for (var i in this.playersToAdd) {
        if (this.playersToAdd[i].playerName === playerName) {
            this.playersToAdd.splice(i, 1);
        }
    }
};

Table.prototype.NewRound = function () {
    // Add players in waiting list
    logGame(this.tableNumber, 'newRound function, start init data');
    var removeIndex = 0;
    var i;
    for (i in this.playersToAdd) {
        var temp = i;
        this.players.push(this.playersToAdd[i]);
    }
    this.playersToAdd = [];
    this.gameWinners = [];
    this.gameLosers = [];

    var smallBlindIndex, bigBlindIndex;
    // Deal 2 cards to each player
    for (i = 0; i < this.players.length; i += 1) {
        if (this.players[i].isSurvive) {
            this.players[i].cards.push(this.game.deck.pop());
            this.players[i].cards.push(this.game.deck.pop());
        }
        this.game.bets[i] = 0;
        this.game.roundBets[i] = 0;
    }

    // Identify Small and Big Blind player indexes
    smallBlindIndex = this.findSmallBlind();
    bigBlindIndex = this.findBigBlind(smallBlindIndex);
    this.smallBlindIndex = smallBlindIndex;
    this.bigBlindIndex = bigBlindIndex;

    // Identify Small and Big Blind player indexes
    // Force Blind Bets
    if (this.smallBlind >= this.players[smallBlindIndex].chips) {
        this.game.bets[smallBlindIndex] = this.players[smallBlindIndex].chips;
        this.players[smallBlindIndex].chips = 0;
        this.players[smallBlindIndex].allIn = true;
        this.players[smallBlindIndex].talked = true;
        this.surviveCount--;
    } else {
        this.players[smallBlindIndex].chips -= this.smallBlind;
        this.game.bets[smallBlindIndex] = this.smallBlind;
    }

    if (this.bigBlind >= this.players[bigBlindIndex].chips) {
        this.game.bets[bigBlindIndex] = this.players[bigBlindIndex].chips;
        this.players[bigBlindIndex].chips = 0;
        this.players[bigBlindIndex].allIn = true;
        this.players[bigBlindIndex].talked = true;
        this.surviveCount--;
    } else {
        this.players[bigBlindIndex].chips -= this.bigBlind;
        //if (this.players[bigBlindIndex].chips % 1 !== 0)
        // this.players[bigBlindIndex].chips = parseInt(this.players[bigBlindIndex].chips);
        this.game.bets[bigBlindIndex] = this.bigBlind;
    }

    // emit __new_round message after small blind and big blind is decided
    var data = getBasicData(this);
    this.eventEmitter.emit('__new_round', data);//add first round notification

    // Get currentPlayer
    this.currentPlayer = bigBlindIndex;
    this.eventEmitter.emit('newRound');
};

Table.prototype.findSmallBlind = function () {
    var smallBlind = this.dealer;
    if (smallBlind >= this.players.length) {
        smallBlind = 0;
    }
    while (!this.players[smallBlind].isSurvive) {
        smallBlind++;
        //fix bug out of index
        if (smallBlind >= this.players.length) {
            smallBlind = 0;
        }
    }
    return smallBlind;
};

Table.prototype.findBigBlind = function (smallBindIndex) {
    var bigBlind = smallBindIndex + 1;
    if (bigBlind >= this.players.length) {
        bigBlind -= this.players.length;
    }
    while (!this.players[bigBlind].isSurvive) {
        bigBlind++;
        //fix bug out of index
        if (bigBlind >= this.players.length) {
            bigBlind -= this.players.length;
        }
    }
    return bigBlind;
};

/*
 Table.prototype.start1stRound = function() {
 // emit a fake gameOver to kick off the 1st round
 this.eventEmitter.emit('1stRound');
 };
 */

Player.prototype.GetChips = function (cash) {
    this.chips += cash;
};

// Player actions: Check(), Fold(), Bet(bet), Call(), AllIn()
Player.prototype.Check = function () {
    var checkAllow, v, i;

    checkAllow = true;

    logGame(this.table.tableNumber, 'player : ' + this.playerName + ', request to CHECK');

    for (v = 0; v < this.table.game.bets.length; v += 1) {
        if (this.table.game.bets[v] !== 0) {
            checkAllow = false;
        }
    }
    if (checkAllow) {
        for (i = 0; i < this.table.players.length; i += 1) {
            if (this === this.table.players[i]) {
                this.table.game.bets[i] = 0;
                this.talked = true;
            }
        }
        // Attempt to progress the game
        this.turnBet = {action: 'check', playerName: this.playerName, chips: this.chips};
        this.table.eventEmitter.emit('showAction', this.turnBet);

        logGame(this.table.tableNumber, 'player : ' + this.playerName + ', CHECK performed');
        progress(this.table);
    } else {
        logGame(this.table.tableNumber, 'player : ' + this.playerName + ', CHECK is not allowed, default to CALL');
        this.Call();
    }
};

Player.prototype.Fold = function () {
    var i, bet;

    logGame(this.table.tableNumber, 'player : ' + this.playerName + ', request to FOLD');

    // Move any current bet into the pot
    for (i = 0; i < this.table.players.length; i += 1) {
        if (this === this.table.players[i]) {
            bet = parseInt(this.table.game.bets[i], 10);
            this.talked = true;
        }
    }
    // Mark the player as folded
    this.folded = true;
    this.turnBet = {action: 'fold', playerName: this.playerName, chips: this.chips};
    logGame(this.table.tableNumber, 'player : ' + this.playerName + ' FOLD performed');
    this.table.eventEmitter.emit('showAction', this.turnBet);
    this.table.surviveCount--;
    // Attempt to progress the game
    progress(this.table);
};

Player.prototype.Raise = function () {
    logGame(this.table.tableNumber, 'player : ' + this.playerName + ', request to RAISE');

    if (this.table.raiseCount >= 4) {
        logGame(this.table.tableNumber, 'player : ' + this.playerName + ', table raise times(' + this.table.raiseCount + ') exceeded, default to Call');
        this.Call();
    } else {
        var maxBet, i, bet;
        maxBet = getMaxBet(this.table.game.bets);
        for (i = 0; i < this.table.players.length; i += 1) {
            if (this === this.table.players[i]) {
                var myBet = 0;
                if (this.table.game.bets[i] >= 0) {
                    myBet = this.table.game.bets[i];
                }
                bet = 2 * maxBet;
                if (this.chips + myBet > bet) {
                    this.chips = this.chips + myBet - bet;
                    //if (this.chips % 1 !== 0)
                    //this.chips = parseFloat(this.chips.toFixed(2));

                    var addMoney = parseInt(bet - myBet);
                    this.table.game.bets[i] = bet;
                    this.turnBet = {action: 'raise', playerName: this.playerName, amount: addMoney, chips: this.chips};
                    this.table.eventEmitter.emit('showAction', this.turnBet);
                    this.table.raiseCount++;
                    logGame(this.table.tableNumber, 'player : ' + this.playerName + ', RAISE performed, table raise times = ' +
                        this.table.raiseCount);

                    for (var j = 0; j < this.table.players.length; j += 1) {
                        if (!this.table.players[j].allIn && !this.table.players[j].folded && this.table.players[j].isSurvive) {
                            this.table.players[j].talked = false;
                        }
                    }

                    this.talked = true;
                    progress(this.table);
                } else {
                    logGame(this.table.tableNumber, 'player : ' + this.playerName + ', not enough chips(chips: ' +
                        this.chips + ', bet : ' + myBet + ', going to bet : ' + bet + ') default to ALLIN');
                    this.AllIn();
                }
                break;
            }
        }
    }
};

Player.prototype.Bet = function (bet) {
    var maxBet = getMaxBet(this.table.game.bets);
    this.table.isBet = false;
    var i;

    logGame(this.table.tableNumber, 'player : ' + this.playerName + ', request to BET');

    if (bet < this.table.bigBlind) {
        logGame(this.table.tableNumber, 'player : ' +
            this.playerName + ', bet(' + bet + ') < big blind(' + this.table.bigBlind + '), default to bet big blind : ' + this.table.bigBlind);
        bet = this.table.bigBlind;
    }
    if (this.chips > bet) {
        for (i = 0; i < this.table.players.length; i += 1) {
            if (this === this.table.players[i]) {
                var myBet = this.table.game.bets[i];
                if (myBet + bet > maxBet && this.table.betCount < 4) {
                    this.table.betCount++;
                    this.table.game.bets[i] += bet;
                    this.table.players[i].chips -= bet;

                    //if (this.table.players[i].chips % 1 !== 0)
                    //this.table.players[i].chips = parseFloat(this.table.players[i].chips.toFixed(2));

                    //update other player
                    for (var j = 0; j < this.table.players.length; j += 1) {
                        if (!this.table.players[j].allIn && !this.table.players[j].folded && this.table.players[j].isSurvive) {
                            this.table.players[j].talked = false;

                        }
                    }

                    this.talked = true;

                    // Attempt to progress the game
                    this.turnBet = {action: 'bet', playerName: this.playerName, amount: bet, chips: this.chips};
                    this.table.eventEmitter.emit('showAction', this.turnBet);
                    logGame(this.table.tableNumber, 'player : ' + this.playerName + ', BET performed : ' + bet);
                    progress(this.table);
                } else {
                    if (myBet + bet > maxBet)
                        logGame(this.table.tableNumber, "betCount =" + this.table.betCount + " can't bet again, auto call");
                    else
                        logGame(this.table.tableNumber, 'player : ' + this.playerName + ', bet amount(' + bet + ') < minbet(' + (maxBet - myBet) + '), default to CALL');
                    this.Call();
                }
                break;
            }
        }
    } else {
        logGame(this.table.tableNumber, 'player : ' + this.playerName + ', not enough chips (chips: ' + this.chips + ') default to ALLIN');
        this.AllIn();
    }
};

Player.prototype.Call = function () {
    var maxBet, i;

    logGame(this.table.tableNumber, 'player : ' + this.playerName + ', request to CALL');

    maxBet = getMaxBet(this.table.game.bets);

    // Match the highest bet
    for (i = 0; i < this.table.players.length; i += 1) {
        if (this === this.table.players[i]) {
            var myBet = 0;
            if (this.table.game.bets[i] >= 0) {
                myBet = this.table.game.bets[i];
            }
            if (this.chips + myBet > maxBet) {
                this.chips = this.chips + myBet - maxBet;
                //if (this.chips % 1 !== 0)
                //this.chips = parseFloat(this.chips.toFixed(2));

                var addMoney = parseInt(maxBet - myBet);
                this.table.game.bets[i] = maxBet;
                this.talked = true;

                this.turnBet = {action: 'call', playerName: this.playerName, amount: addMoney, chips: this.chips};
                this.table.eventEmitter.emit('showAction', this.turnBet);
                logGame(this.table.tableNumber, 'player : ' + this.playerName + ', CALL performed');
                progress(this.table);
            } else {
                logGame(this.table.tableNumber, 'player : ' + this.playerName + ', not enough chips (chips: ' + this.chips + ') default to ALLIN');
                this.AllIn();
            }
        }
    }
};

Player.prototype.AllIn = function () {
    var i, allInValue = 0, myBet = 0;

    logGame(this.table.tableNumber, 'player : ' + this.playerName + ', request to ALLIN');

    for (i = 0; i < this.table.players.length; i += 1) {
        if (this === this.table.players[i]) {
            if (this.table.players[i].chips !== 0) {
                allInValue = this.table.players[i].chips;
                this.table.game.bets[i] += this.table.players[i].chips;
                this.table.players[i].chips = 0;
                this.allIn = true;
                this.talked = true;
                this.table.surviveCount--;
                myBet = this.table.game.bets[i];
            }
            break;
        }
    }

    // if player bet < myBet, the player need to call
    for (i = 0; i < this.table.players.length; i++) {
        var bet = this.table.game.bets[i];
        var player = this.table.players[i];
        if (player.isSurvive && !player.folded && !player.allIn && bet < myBet) {
            player.talked = false;
        }
    }

    // Attempt to progress the game
    this.turnBet = {action: 'allin', playerName: this.playerName, amount: allInValue, chips: this.chips};
    this.table.eventEmitter.emit('showAction', this.turnBet);
    logGame(this.table.tableNumber, 'player : ' + this.playerName + ', ALLIN performed');
    progress(this.table);
};

function rankHands(hands) {
    var x, myResult;

    for (x = 0; x < hands.length; x += 1) {
        myResult = rankHandInt(hands[x]);
        hands[x].rank = myResult.rank;
        hands[x].message = myResult.message;
    }

    return hands;
}

function logGame(tableNumber, msg) {
    logger.info('>>> table ' + tableNumber + ' >>> ' + msg);
}

exports.Table = Table;
exports.getBasicData = getBasicData;
exports.getPlayerReloadData = getPlayerReloadData;
exports.getNextPlayer = getNextPlayer;
exports.getNextDealer = getNextDealer;
