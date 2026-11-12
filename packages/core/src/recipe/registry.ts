import fs from 'node:fs'
import path from 'node:path'
import { uhHome } from '../paths.ts'
import { BUILTIN_RECIPES } from './builtin.ts'
import type { Recipe } from './types.ts'

export function userRecipeDir(): string {
  return path.join(uhHome(), 'recipes')
}

function readRecipe(file: string): Recipe | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Recipe
    if (!raw.name || !Array.isArray(raw.task)) return null
    return raw
  } catch {
    return null
  }
}

function readDir(dir: string): Recipe[] {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out: Recipe[] = []
  for (const e of entries) {
    if (!e.isFile() || !String(e.name).endsWith('.json')) continue
    const r = readRecipe(path.join(dir, String(e.name)))
    if (r) out.push(r)
  }
  return out
}

export interface RecipeListEntry {
  recipe: Recipe
  source: 'builtin' | 'user'
  path: string
}

export function listRecipes(): RecipeListEntry[] {
  const byName = new Map<string, RecipeListEntry>()

  for (const r of BUILTIN_RECIPES) {
    byName.set(r.name, { recipe: r, source: 'builtin', path: '<builtin>' })
  }
  const udir = userRecipeDir()
  for (const r of readDir(udir)) {
    byName.set(r.name, { recipe: r, source: 'user', path: path.join(udir, `${r.name}.json`) })
  }

  return [...byName.values()].sort((a, b) => a.recipe.name.localeCompare(b.recipe.name))
}

export function loadRecipe(name: string): RecipeListEntry | null {
  return listRecipes().find((e) => e.recipe.name === name) ?? null
}

/** {{var}} 替换；未提供的变量回落默认值，缺了就留原文（让模型看见，而不是变成空串） */
export function renderTemplate(text: string, vars: Record<string, string | number>): string {
  return text.replace(/\{\{\s*([a-zA-Z0-9_-]+)\s*\}\}/g, (whole, key: string) => {
    const v = vars[key]
    return v === undefined ? whole : String(v)
  })
}

export function resolveVars(recipe: Recipe, given: Record<string, string>): Record<string, string | number> {
  const out: Record<string, string | number> = { ...(recipe.vars ?? {}) }
  for (const [k, v] of Object.entries(given)) out[k] = v
  return out
}
