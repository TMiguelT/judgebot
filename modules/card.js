const rp = require("request-promise-native");
const _ = require("lodash");
const Discord = require("discord.js");
const utils = require("../utils");
const log = utils.getLogger('card');
const cheerio = require("cheerio");

class MtgCardLoader {
    constructor() {
        this.commands = {
            card: {
                aliases: [],
                inline: true,
                description: "Search for an English Magic card by (partial) name, supports full Scryfall syntax",
                help: '',
                examples: ["!card iona", "!card t:creature o:flying", "!card goyf e:fut"]
            },
            price: {
                aliases: ["prices"],
                inline: true,
                description: "Show the price in USD, EUR and TIX for a card",
                help: '',
                examples: ["!price tarmogoyf"]
            },
            ruling: {
                aliases: ["rulings"],
                inline: true,
                description: "Show the Gatherer rulings for a card",
                help: '',
                examples: ["!ruling sylvan library"]
            },
            legal: {
                aliases: ["legality"],
                inline: true,
                description: "Show the format legality for a card",
                help: '',
                examples: ["!legal divining top"]
            }
        };
        this.cardApi = "https://api.scryfall.com/cards/search?q=";
        this.cardApiFuzzy = "https://api.scryfall.com/cards/named?fuzzy=";
        // Discord bots can use custom emojis globally, so we just reference these Manamoji through their code / ID
        // (currently hosted on the Judgebot testing discord)
        // @see https://github.com/scryfall/thopter/tree/master/manamoji
        this.manamojis = {
            "bp": "manabp:698866510726299668",
            "9": "mana9:698866510692876338",
            "10": "mana10:698866510675968050",
            "1": "mana1:698866510667710464",
            "2g": "mana2g:698866510634025030",
            "chaos": "manachaos:698866510587756604",
            "8": "mana8:698866510583824384",
            "11": "mana11:698866510571241502",
            "2r": "mana2r:698866510567047208",
            "2w": "mana2w:698866510567047198",
            "12": "mana12:698866510566916206",
            "13": "mana13:698866510566916147",
            "rg": "manarg:698866510545944586",
            "0": "mana0:698866510541750282",
            "5": "mana5:698866510537424937",
            "16": "mana16:698866510533230602",
            "2b": "mana2b:698866510512390144",
            "w": "manaw:698866510495744060",
            "2u": "mana2u:698866510482898955",
            "6": "mana6:698866510461927494",
            "bg": "manabg:698866510453669898",
            "4": "mana4:698866510449475654",
            "14": "mana14:698866510441087067",
            "b": "manab:698866510415790140",
            "15": "mana15:698866510411595857",
            "20": "mana20:698866510399275019",
            "gp": "managp:698866510395080714",
            "rp": "manarp:698866510374109194",
            "gw": "managw:698866510365458552",
            "gu": "managu:698866510361395250",
            "2": "mana2:698866510361395222",
            "c": "manac:698866510357331988",
            "g": "manag:698866510353006602",
            "q": "manaq:698866510290223104",
            "ub": "manaub:698866510281703454",
            "wb": "manawb:698866510277378128",
            "s": "manas:698866510273445928",
            "u": "manau:698866510269120522",
            "7": "mana7:698866510235697183",
            "ur": "manaur:698866510214725652",
            "rw": "manarw:698866510210400267",
            "wp": "manawp:698866510189297757",
            "wu": "manawu:698866510181171230",
            "r": "manar:698866510172520529",
            "e": "manae:698866510138966027",
            "3": "mana3:698866510130839604",
            "t": "manat:698866510042759242",
            "br": "manabr:698866510017593435",
            "up": "manaup:698866509975519304",
            "x": "manax:698866509786775674",
        };
        // embed border colors depending on card color(s)
        this.colors = {
            "W": 0xF8F6D8,
            "U": 0xC1D7E9,
            "B": 0x0D0F0F,
            "R": 0xE49977,
            "G": 0xA3C095,
            "GOLD": 0xE0C96C,
            "ARTIFACT": 0x90ADBB,
            "LAND": 0xAA8F84,
            "NONE": 0xDAD9DE
        };
        // cache for Discord permission lookup
        this.permissionCache = {};
    }

    getCommands() {
        return this.commands;
    }

    // replace mana and other symbols with actual emojis
    renderEmojis(text) {
        return text.replace(/{[^}]+?}/ig, match => {
            const code = match.replace(/[^a-z0-9]/ig,'').toLowerCase();
            return this.manamojis[code] ? '<:'+this.manamojis[code]+'>':'';
        });
    }

    // determine embed border color
    getBorderColor(card) {
        let color;
        if (!card.colors || card.colors.length === 0) {
            color = this.colors.NONE;
            if (card.type_line && card.type_line.match(/artifact/i)) color = this.colors.ARTIFACT;
            if (card.type_line && card.type_line.match(/land/i)) color = this.colors.LAND;
        } else if (card.colors.length > 1) {
            color = this.colors.GOLD;
        } else {
            color = this.colors[card.colors[0]];
        }
        return color;
    }

    // parse Gatherer rulings
    parseGathererRulings(gatherer) {
        const $ = cheerio.load(gatherer);
        const rulings = [];
        $('.rulingsTable tr').each((index,elem) => {
            rulings.push('**'+$(elem).find('td:nth-child(1)').text()+':** '+$(elem).find('td:nth-child(2)').text());
            if (rulings.join('\n').length > 2040) {
                rulings[rulings.length - 1] = '...';
                return false;
            }
        });
        return rulings.join('\n');
    }

    // generate description text from a card object
    generateDescriptionText(card) {
        const ptToString = (card) =>
            '**'+card.power.replace(/\*/g, '\\*') + "/" + card.toughness.replace(/\*/g, '\\*')+'**';

        const description = [];
        if (card.type_line) { // bold type line
            let type = `**${card.printed_type_line || card.type_line}** `;
            type += `(${card.set.toUpperCase()} ${_.capitalize(card.rarity)}`;
            type += `${card.lang && card.lang !== 'en' ? ' :flag_' + card.lang + ':':''})`;
            description.push(type);
        }
        if (card.oracle_text) { // reminder text in italics
            const text = card.printed_text || card.oracle_text;
            description.push(text.replace(/[()]/g, m => m === '(' ? '*(':')*'));
        }
        if (card.flavor_text) { // flavor text in italics
            description.push('*' + card.flavor_text+'*');
        }
        if (card.loyalty) { // bold loyalty
            description.push('**Loyalty: ' + card.loyalty+'**');
        }
        if (card.power) { // bold P/T
            description.push(ptToString(card));
        }
        if (card.card_faces) {
            // split cards are special
            card.card_faces.forEach(face => {
                description.push('**'+face.type_line+'**');
                if (face.oracle_text) {
                    description.push(face.oracle_text.replace(/[()]/g, m => m === '(' ? '*(':')*'));
                }
                if (face.power) {
                    description.push(ptToString(face));
                }
                description.push('');
            });
        }
        return description.join('\n');
    }

    // generate the embed card
    generateEmbed(cards, command, hasEmojiPermission) {
        return new Promise(resolve => {
            const card = cards[0];

            // generate embed title and description text
            // use printed name (=translated) over English name, if available
            let title = card.printed_name || card.name;

            if (card.mana_cost) {
                title += ' ' + card.mana_cost;
            }

            // DFC use card_faces array for each face
            if (card.layout === 'transform' && card.card_faces) {
                if (card.card_faces[0].mana_cost) {
                    title += ' ' + card.card_faces[0].mana_cost;
                }
                card.image_uris = card.card_faces[0].image_uris;
            }

            let description = this.generateDescriptionText(card);

            // are we allowed to use custom emojis? cool, then do so, but make sure the title still fits
            if(hasEmojiPermission) {
                title = _.truncate(this.renderEmojis(title), {length: 256, separator: '<'});
                description = this.renderEmojis(description);
            }

            // footer
            let footer = "Use !help to get a list of available commands.";
            if(cards.length > 1) {
                footer = (cards.length - 1) + ' other hits:\n';
                footer += cards.slice(1,6).map(cardObj => (cardObj.printed_name || cardObj.name)).join('; ');
                if (cards.length > 6) footer += '; ...';
            }

            // instantiate embed object
            const embed = new Discord.MessageEmbed({
                title,
                description,
                footer: {text: footer},
                url: card.scryfall_uri,
                color: this.getBorderColor(card.layout === 'transform' ? card.card_faces[0]:card),
                thumbnail: card.image_uris ? {url: card.image_uris.small} : null,
                image: card.zoom && card.image_uris ? {url: card.image_uris.normal} : null
            });

            // add pricing, if requested
            if (command.match(/^price/) && card.prices) {
                let prices = [];
                if(card.prices.usd) prices.push('$' + card.prices.usd);
                if(card.prices.usd_foil) prices.push('**Foil** $' + card.prices.usd_foil);
                if(card.prices.eur) prices.push(card.prices.eur + '€');
                if(card.prices.tix) prices.push(card.prices.tix + ' Tix');
                embed.addField('Prices', prices.join(' / ') || 'No prices found');
            }

            // add legalities, if requested
            if (command.match(/^legal/)) {
                const legalities = (_.invertBy(card.legalities).legal || []).map(_.capitalize).join(', ');
                embed.addField('Legal in', legalities || 'Nowhere');
            }

            // add rulings loaded from Gatherer, if needed
            if(command.match(/^ruling/) && card.related_uris.gatherer) {
                rp(card.related_uris.gatherer).then(gatherer => {
                    embed.setAuthor('Gatherer rulings for');
                    embed.setDescription(this.parseGathererRulings(gatherer));
                    resolve(embed);
                });
            } else {
                resolve(embed);
            }
        });
    }

    /**
     * Fetch the cards from Scryfall
     * @param cardName
     * @returns {Promise<Object>}
     */
    getCards(cardName) {
        let requestPromise;
        requestPromise = new Promise((resolve, reject) => {
            rp({url: this.cardApi + encodeURIComponent(cardName + ' include:extras'), json: true}).then(body => {
                if(body.data && body.data.length) {
                    // sort the cards to better match the search query (issue #87)
                    body.data.sort((a, b) => this.scoreHit(b, cardName) - this.scoreHit(a, cardName));
                }
                resolve(body);
            }, () => {
                log.info('Falling back to fuzzy search for '+cardName);
                rp({url: this.cardApiFuzzy + encodeURIComponent(cardName), json: true})
                    .then(response => resolve({data: [response]}), reject);
            });
        });
        return requestPromise;
    }

    /**
     * Calculate the hit score for a card and a search query
     * @param card
     * @param query
     */
    scoreHit(card, query) {
        const name = (card.printed_name || card.name).toLowerCase().replace(/[^a-z0-9]/g, '');
        const nameQuery = query.split(" ").filter(q => !q.match(/[=:()><]/)).join(" ").toLowerCase().replace(/[^a-z0-9]/g, '');
        let score = 0;
        if (name === nameQuery) {
            // exact match - to the top!
            score = 10000;
        } else if(name.match(new RegExp('^'+nameQuery))) {
            // match starts at the beginning of the name
            score = 1000 * nameQuery.length / name.length;
        } else {
            // match anywhere but the beginning
            score = 100 * nameQuery.length / name.length;
        }
        return score;
    }

    /**
     * Handle an incoming message
     * @param command
     * @param parameter
     * @param msg
     * @returns {Promise}
     */
    handleMessage(command, parameter, msg) {
        const cardName = parameter.toLowerCase();
        // no card name, no lookup
        if (!cardName) return;
        const permission = true; // assume we have custom emoji permission for now
        // fetch data from API
        this.getCards(cardName).then(body => {
            // check if there are results
            if (body.data && body.data.length) {
                // generate embed
                this.generateEmbed(body.data, command, permission).then(embed => {
                    return msg.channel.send('', {embed});
                }, err => log.error(err)).then(sentMessage => {
                    // add reactions for zoom and paging
                    sentMessage.react('🔍').then(() => {
                        if (body.data.length > 1) {
                            sentMessage.react('⬅').then(() => sentMessage.react('➡'));
                        }
                    }).catch(() => {});

                    const handleReaction = reaction => {
                        if (reaction.emoji.toString() === '⬅') {
                            body.data.unshift(body.data.pop());
                        } else if (reaction.emoji.toString() === '➡') {
                            body.data.push(body.data.shift());
                        } else {
                            // toggle zoom
                            body.data[0].zoom = !body.data[0].zoom;
                        }
                        // edit the message to update the current card
                        this.generateEmbed(body.data, command, permission).then(embed => {
                            sentMessage.edit('', {embed});
                        }).catch(() => {});
                    }

                    sentMessage.createReactionCollector(
                        ({emoji} , user) => ['⬅','➡','🔍'].indexOf(emoji.toString()) > -1 && user.id === msg.author.id,
                        {time: 5 * 60 *  1000}
                    ).on('collect', handleReaction).on('remove', handleReaction);
                }, err => log.error(err)).catch(() => {});
            }
        }).catch(err => {
            let description = 'No cards matched `'+cardName+'`.';
            if (err.statusCode === 503) {
                description = 'Scryfall is currently offline, please try again later.'
            }
            return msg.channel.send('', {embed: new Discord.MessageEmbed({
                title: 'Error',
                description,
                color: 0xff0000
            })});
        });
    }
}

module.exports = MtgCardLoader;
