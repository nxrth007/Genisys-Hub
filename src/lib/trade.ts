/**
 * What kind of contractor a client is, read off the onboarding form.
 *
 * The form never asks "what's your trade" — it asks for the business name,
 * the services they want promoted and a paragraph about the business.
 * This reads those for trade words and ranks them: the business name
 * counts most ("J&R Painting" settles it), the services list next, the
 * about-paragraph least. Two trades that often go together and tie
 * ("Forte Brick and Concrete") read as one phrase: "masonry and concrete
 * contractor". Nothing recognisable → "" and a person types it.
 *
 * The result is a lower-case phrase for a sentence like
 * "[Business] is a … in [City]", so it ends in contractor / company /
 * builder / installer, not a bare noun.
 */

type TradeDef = {
  /** The phrase, e.g. "roofing contractor". */
  phrase: string
  /** Words that mean this trade. Whole-word, case-insensitive; a trailing * allows any ending (roof* → roofing, roofer, roofs). */
  words: string[]
  /** Trades this one pairs with naturally; a tie reads "X and Y contractor". */
  pairs?: string[]
  /** Only count this when nothing more specific was found ("construction" is in a lot of names). */
  generic?: boolean
}

const TRADES: TradeDef[] = [
  { phrase: 'roofing contractor', words: ['roof*', 'shingle*', 're-roof*', 'reroof*'], pairs: ['siding contractor', 'gutter contractor'] },
  { phrase: 'siding contractor', words: ['siding', 'hardie*', 'vinyl siding'], pairs: ['roofing contractor', 'window and door contractor'] },
  { phrase: 'gutter contractor', words: ['gutter*'], pairs: ['roofing contractor'] },
  { phrase: 'concrete contractor', words: ['concrete', 'driveway*', 'slab*', 'flatwork', 'foundation*', 'sidewalk*', 'stamped'], pairs: ['masonry contractor', 'paving contractor'] },
  { phrase: 'masonry contractor', words: ['masonry', 'mason*', 'brick*', 'block', 'stone*', 'paver*', 'stucco', 'chimney*', 'stoop*', 'retaining wall*'], pairs: ['concrete contractor'] },
  { phrase: 'paving contractor', words: ['paving', 'asphalt', 'sealcoat*', 'blacktop'], pairs: ['concrete contractor'] },
  { phrase: 'painting contractor', words: ['paint*', 'stain*', 'cabinet refinish*', 'drywall repair'], pairs: ['drywall contractor'] },
  { phrase: 'drywall contractor', words: ['drywall', 'sheetrock', 'plaster*', 'texture'], pairs: ['painting contractor'] },
  { phrase: 'fence contractor', words: ['fenc*', 'gate*', 'privacy fence'], pairs: ['deck builder'] },
  { phrase: 'deck builder', words: ['deck*', 'pergola*', 'patio cover*', 'gazebo*'], pairs: ['fence contractor'] },
  { phrase: 'plumber', words: ['plumb*', 'drain*', 'water heater*', 'repipe*', 'sewer*'], pairs: ['HVAC contractor'] },
  { phrase: 'electrician', words: ['electric*', 'wiring', 'panel upgrade*', 'ev charger*'], pairs: ['HVAC contractor'] },
  { phrase: 'HVAC contractor', words: ['hvac', 'heating', 'cooling', 'air', 'air conditioning', 'a/c', 'ac repair', 'ac', 'furnace*', 'heat pump*', 'ductwork', 'mini split*', 'mini-split*'], pairs: ['plumber', 'electrician'] },
  { phrase: 'landscaping company', words: ['landscap*', 'lawn*', 'sod', 'irrigation', 'sprinkler*', 'hardscap*', 'mulch*', 'yard*'], pairs: ['tree service'] },
  { phrase: 'tree service', words: ['tree*', 'arborist*', 'stump*'], pairs: ['landscaping company'] },
  { phrase: 'remodeling contractor', words: ['remodel*', 'renovat*', 'kitchen*', 'bathroom*', 'basement*', 'addition*'], pairs: ['general contractor'] },
  { phrase: 'flooring contractor', words: ['floor*', 'tile', 'tiling', 'hardwood', 'laminate', 'vinyl plank', 'lvp', 'carpet*', 'epoxy'] },
  { phrase: 'window and door contractor', words: ['window*', 'door*', 'glass', 'glazing'], pairs: ['siding contractor'] },
  { phrase: 'garage door company', words: ['garage door*', 'overhead door*'] },
  { phrase: 'pressure washing company', words: ['pressure wash*', 'power wash*', 'soft wash*', 'softwash*'] },
  { phrase: 'cleaning company', words: ['house cleaning', 'home cleaning', 'cleaning service*', 'cleaning company', 'commercial cleaning', 'residential cleaning', 'janitorial', 'maid*', 'housekeep*'] },
  { phrase: 'pool contractor', words: ['pool*', 'spa*', 'hot tub*'] },
  { phrase: 'solar installer', words: ['solar*', 'photovoltaic', 'pv'] },
  { phrase: 'insulation contractor', words: ['insulation', 'spray foam', 'attic*'] },
  { phrase: 'pest control company', words: ['pest*', 'extermina*', 'termite*', 'mosquito*', 'wildlife removal'] },
  { phrase: 'moving company', words: ['mover*', 'moving', 'relocat*'] },
  { phrase: 'junk removal company', words: ['junk*', 'hauling', 'haul away', 'debris removal', 'dumpster*'] },
  { phrase: 'excavation contractor', words: ['excavat*', 'grading', 'dirt work', 'land clearing', 'demolition', 'trench*'] },
  { phrase: 'welding and fabrication shop', words: ['weld*', 'fabricat*', 'ironwork*', 'metal work*', 'railing*'] },
  { phrase: 'cabinet maker', words: ['cabinet*', 'cabinetry', 'millwork'] },
  { phrase: 'countertop installer', words: ['countertop*', 'granite', 'quartz', 'marble'] },
  { phrase: 'waterproofing contractor', words: ['waterproof*', 'foundation repair', 'crawl space*', 'crawlspace*', 'french drain*'] },
  { phrase: 'septic contractor', words: ['septic*'] },
  { phrase: 'handyman service', words: ['handyman', 'handy man', 'odd jobs', 'repairs'] },
  { phrase: 'carpentry contractor', words: ['carpent*', 'framing', 'trim work', 'finish carpentry', 'custom woodwork*'] },
  { phrase: 'home builder', words: ['home builder*', 'custom home*', 'new construction', 'homebuilder*'], pairs: ['general contractor'] },
  { phrase: 'general contractor', words: ['general contractor*', 'construction', 'contracting', 'builder*', 'build*', 'restoration', 'home improvement*'], generic: true, pairs: ['remodeling contractor', 'home builder'] },
]

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** One regex per trade: whole words, optional "*" suffix wildcard, spaces match any whitespace or hyphen. */
const PATTERNS: Array<{ def: TradeDef; re: RegExp }> = TRADES.map((def) => ({
  def,
  re: new RegExp(
    `\\b(?:${def.words
      .map((w) => {
        const star = w.endsWith('*')
        const body = esc(star ? w.slice(0, -1) : w).replace(/\\\*/g, '\\*').replace(/ /g, '[\\s-]+')
        return star ? `${body}\\w*` : body
      })
      .join('|')})\\b`,
    'gi',
  ),
}))

const WEIGHTS = { name: 6, services: 3, about: 1 } as const

export type TradeGuess = {
  trade: string
  /** Top candidates, best first — for a hint or a dropdown. */
  candidates: { phrase: string; score: number }[]
  /** What the guess rests on. */
  basis: Array<'name' | 'services' | 'about'>
}

/** The trade phrase for a sentence like "[Business] is a … in [City]"; "" when nothing recognisable. */
export function inferTrade(src: { businessName?: string | null; mainServices?: string | null; aboutBusiness?: string | null }): TradeGuess {
  const scores = new Map<string, number>()
  /** Where a trade first appeared: in the name (0–999), the services list (1000+), the about text (100000+). Earlier = more primary. */
  const pos = new Map<string, number>()
  const basis = new Set<'name' | 'services' | 'about'>()
  const feed = (text: string | null | undefined, weight: number, source: 'name' | 'services' | 'about') => {
    if (!text?.trim()) return
    const base = source === 'name' ? 0 : source === 'services' ? 1000 : 100000
    for (const { def, re } of PATTERNS) {
      re.lastIndex = 0
      const first = re.exec(text)
      const hits = first ? (text.match(re)?.length ?? 1) : 0
      if (!hits || !first) continue
      if (!pos.has(def.phrase)) pos.set(def.phrase, base + first.index)
      // Repeated mentions in a paragraph shouldn't outweigh one clear name.
      const n = source === 'name' ? 1 : Math.min(hits, 3)
      scores.set(def.phrase, (scores.get(def.phrase) ?? 0) + n * weight)
      basis.add(source)
    }
  }
  feed(src.businessName, WEIGHTS.name, 'name')
  feed(src.mainServices, WEIGHTS.services, 'services')
  feed(src.aboutBusiness, WEIGHTS.about, 'about')

  // "Construction" in a name means a general contractor only when nothing more specific showed up.
  for (const def of TRADES) {
    if (def.generic && scores.has(def.phrase) && [...scores.keys()].some((p) => p !== def.phrase)) {
      scores.set(def.phrase, scores.get(def.phrase)! / 4)
    }
  }

  const ranked = [...scores.entries()]
    .map(([phrase, score]) => ({ phrase, score }))
    .sort((a, b) => b.score - a.score || (pos.get(a.phrase) ?? 1e9) - (pos.get(b.phrase) ?? 1e9))
  if (!ranked.length) return { trade: '', candidates: [], basis: [] }

  const [first, second] = ranked
  const def = TRADES.find((t) => t.phrase === first.phrase)!
  let trade = first.phrase
  // A close second that pairs with the first reads as one phrase:
  // "masonry and concrete contractor", "roofing and siding contractor".
  if (second && def.pairs?.includes(second.phrase) && second.score >= first.score * 0.5) {
    // "Fence & Deck" reads fence first, however the services list scored.
    const firstLeads = (pos.get(first.phrase) ?? 1e9) <= (pos.get(second.phrase) ?? 1e9)
    trade = firstLeads ? joinTrades(first.phrase, second.phrase) : joinTrades(second.phrase, first.phrase)
  }
  return { trade, candidates: ranked.slice(0, 4), basis: [...basis] }
}

/** "masonry contractor" + "concrete contractor" → "masonry and concrete contractor"; different nouns keep both. */
function joinTrades(a: string, b: string): string {
  const [aHead, aNoun] = splitNoun(a)
  const [bHead, bNoun] = splitNoun(b)
  if (aNoun === bNoun && aHead && bHead) return `${aHead} and ${bHead} ${aNoun}`
  return `${a} and ${b}`
}

const NOUNS = ['contractor', 'company', 'builder', 'installer', 'service', 'shop', 'maker']
function splitNoun(phrase: string): [string, string] {
  const noun = NOUNS.find((n) => phrase.endsWith(` ${n}`))
  return noun ? [phrase.slice(0, -(noun.length + 1)), noun] : ['', phrase]
}
