// Generated from src/lib/render.ts - do not edit by hand; run `node build.mjs`.
/**
 * Summary + Mermaid chart rendering.
 *
 * The panel draws its own HTML/SVG from the same report object, and the Mermaid
 * source travels with the JSON feed so scripts can re-render the charts without
 * drifting from what the panel shows.
 */

                                                
import { PERIOD_EN } from './trending.js'
                                                  

                                
              
               
                      
               
               
 

                                
             
            
            
               
               
 

                                
                   
                    
                    
                   
                     
                            
                             
                                                      
                                                          
                       
 

                                 
                      
                         
                     
                       
                        
                         
                    
 

                               
            
               
              
 

const DATE_FORMATTER = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

export function formatDateTime(value               )         {
  const date = typeof value === 'string' ? new Date(value) : value
  try {
    return DATE_FORMATTER.format(date)
  } catch {
    return date.toISOString()
  }
}

function compact(value        )         {
  if (value >= 1000000) return `${(value / 1000000).toFixed(1)}M`
  if (value >= 10000) return `${(value / 1000).toFixed(1)}k`
  return new Intl.NumberFormat('en-US').format(Math.round(value))
}

function pct(value        )         {
  const raw = value * 100
  return raw >= 10 ? `${raw.toFixed(0)}%` : raw >= 1 ? `${raw.toFixed(1)}%` : `${raw.toFixed(2)}%`
}

function mermaidLabel(text        )         {
  const cleaned = text
    .replace(/["\\`]/g, '')
    .replace(/[^\p{L}\p{N}._-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 24)
  return cleaned || 'repo'
}

export function buildSummary(repos                )                {
  const languages = new Map                       ()
  const categories = new Map                       ()
  let totalStars = 0
  let totalDelta = 0
  let enrichedCount = 0
  const riskCount = { high: 0, medium: 0, low: 0 }

  for (const repo of repos) {
    totalStars += repo.stars
    totalDelta += repo.delta
    if (repo.enriched) enrichedCount += 1
    riskCount[repo.riskLevel] += 1

    const languageName = repo.language ?? '未标注'
    const language = languages.get(languageName) ?? {
      name: languageName,
      count: 0,
      color: repo.languageColor,
      stars: 0,
      delta: 0,
    }
    language.count += 1
    language.stars += repo.stars
    language.delta += repo.delta
    if (!language.color && repo.languageColor) language.color = repo.languageColor
    languages.set(languageName, language)

    if (repo.category) {
      const category = categories.get(repo.category) ?? {
        key: repo.category,
        zh: repo.categoryZh,
        en: repo.categoryEn,
        count: 0,
        delta: 0,
      }
      category.count += 1
      category.delta += repo.delta
      categories.set(repo.category, category)
    }
  }

  const languageList = [...languages.values()].sort((a, b) => b.count - a.count || b.delta - a.delta)
  const categoryList = [...categories.values()].sort((a, b) => b.count - a.count || b.delta - a.delta)
  const topMoverRepo = [...repos].sort((a, b) => b.delta - a.delta)[0]

  return {
    repoCount: repos.length,
    totalStars,
    totalDelta,
    avgGrowth: repos.length ? repos.reduce((sum, repo) => sum + repo.growthRatio, 0) / repos.length : 0,
    topLanguage: languageList[0]?.name ?? '—',
    languages: languageList,
    categories: categoryList,
    topMover: topMoverRepo ? { fullName: topMoverRepo.fullName, delta: topMoverRepo.delta } : null,
    riskCount,
    enrichedCount,
  }
}

export function buildMermaid(repos                , summary               )                 {
  const movers = [...repos].sort((a, b) => b.delta - a.delta).slice(0, 10)
  const labels = movers.map((repo) => JSON.stringify(mermaidLabel(repo.name)))
  const deltas = movers.map((repo) => Math.max(0, Math.round(repo.delta)))
  const maxDelta = Math.max(1, ...deltas)
  const step = Math.max(50, Math.ceil(maxDelta / 4 / 50) * 50)
  const axisMax = step * Math.ceil(maxDelta / step)

  const bar = [
    'xychart-beta',
    `    title "${PERIOD_EN[repos[0]?.since ?? 'daily']} star gain (top ${movers.length})"`,
    `    x-axis [${labels.join(', ')}]`,
    `    y-axis "stars" 0 --> ${axisMax}`,
    `    bar [${deltas.join(', ')}]`,
  ].join('\n')

  const languageSlices = summary.languages.slice(0, 6)
  const pieSlices =
    languageSlices.length > 1
      ? languageSlices.map((slice) => ({ name: slice.name, count: slice.count }))
      : summary.categories.slice(0, 6).map((slice) => ({ name: slice.en, count: slice.count }))
  const pieTitle = languageSlices.length > 1 ? 'Language mix' : 'Category mix'
  const charts                 = [
    { id: 'gain', title: 'Star 增量 Top 10', code: bar },
  ]
  // An uncategorised report has nothing to put in the pie; drop the chart
  // instead of inventing an "other" slice.
  if (pieSlices.length > 0) {
    charts.push({
      id: 'language',
      title: languageSlices.length > 1 ? '语言分布' : '分类分布',
      code: [
        'pie showData',
        `    title "${pieTitle}"`,
        ...pieSlices.map((slice) => `    "${mermaidLabel(slice.name)}" : ${slice.count}`),
      ].join('\n'),
    })
  }
  return charts
}
