"use client"

/**
 * Ready-made pickers composed from the shadcn primitives, for the common cases on this site:
 *
 * - <OptionSelect>: a short, fixed list (sizes, speeds, ranks, modes). shadcn Select on Base UI.
 * - <SearchSelect>: a long list you type to narrow (actors, factions). shadcn Combobox with its search input in the
 *   popup; options can carry a description, a leading visual (swatch, cameo) and a group heading.
 *
 * Both keep the value type you pass (string or number), close on Escape and return focus to the trigger, work with
 * a wrapping <label> or an aria-label, and portal their popup to <body> (above dialogs) without locking page scroll.
 * Popups use the dark panel tokens; pass contentClassName="ui-paper" on light surfaces. See ./README.md.
 */
import * as React from "react"
import { cn } from "../../lib/utils"
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue, selectTriggerClassName } from "./select"
import { Combobox, ComboboxCollection, ComboboxContent, ComboboxEmpty, ComboboxGroup, ComboboxInput, ComboboxItem, ComboboxLabel, ComboboxList, ComboboxTrigger, ComboboxValue } from "./combobox"

export type Option<V extends string | number = string> = {
  value: V
  label: string
  /** Secondary text shown after the label (category, side, cost). Searched too. */
  description?: string
  /** A small leading visual: a colour swatch, an icon or a cameo. */
  leading?: React.ReactNode
  /** Heading of the group this option belongs to; options are grouped in first-seen order. */
  group?: string
  disabled?: boolean
}

type Common<V extends string | number> = {
  value: V
  onValueChange: (value: V) => void
  options: readonly Option<V>[]
  id?: string
  "aria-label"?: string
  "aria-describedby"?: string
  disabled?: boolean
  /** Classes for the trigger (the closed field). */
  className?: string
  /** Classes for the popup, e.g. "ui-paper" on a light surface. */
  contentClassName?: string
  size?: "sm" | "default"
}

function grouped<V extends string | number>(options: readonly Option<V>[]) {
  if (!options.some(o => o.group)) return null
  const groups: { value: string; items: Option<V>[] }[] = []
  for (const option of options) {
    const name = option.group ?? ""
    let group = groups.find(g => g.value === name)
    if (!group) groups.push(group = { value: name, items: [] })
    group.items.push(option)
  }
  return groups
}

function OptionLabel({ option, compact = false }: { option: Option<string | number>; compact?: boolean }) {
  return <>{option.leading}<span className="min-w-0 truncate">{option.label}{!compact && option.description ? <small> · {option.description}</small> : null}</span></>
}

/** A short, fixed list: shadcn Select. */
export function OptionSelect<V extends string | number>({ value, onValueChange, options, id, disabled, className, contentClassName, size, ...aria }: Common<V>) {
  const groups = grouped(options)
  const item = (o: Option<V>) => <SelectItem key={String(o.value)} value={o.value} disabled={o.disabled}><OptionLabel option={o} /></SelectItem>
  return (
    <Select<V> value={value} onValueChange={next => { if (next !== null) onValueChange(next as V) }} items={options.map(o => ({ value: o.value, label: o.label }))} disabled={disabled} modal={false}>
      <SelectTrigger id={id} size={size} className={className} {...aria}>
        <SelectValue>{(current: V) => { const o = options.find(x => x.value === current); return o ? <OptionLabel option={o} compact /> : String(current ?? "") }}</SelectValue>
      </SelectTrigger>
      <SelectContent onClick={e => e.stopPropagation()} className={contentClassName}>
        {groups ? groups.map((g, i) => <React.Fragment key={g.value}>{i > 0 && <SelectSeparator />}<SelectGroup>{g.value && <SelectLabel>{g.value}</SelectLabel>}{g.items.map(item)}</SelectGroup></React.Fragment>) : options.map(item)}
      </SelectContent>
    </Select>
  )
}

/** A long list with a search field: shadcn Combobox, opened from a select-like trigger. */
export function SearchSelect<V extends string | number>({ value, onValueChange, options, id, disabled, className, contentClassName, size = "default", placeholder = "Search…", empty = "Nothing matches that search.", ...aria }: Common<V> & { placeholder?: string; empty?: string }) {
  const [open, setOpen] = React.useState(false)
  const groups = React.useMemo(() => grouped(options), [options])
  const selected = options.find(o => o.value === value) ?? null
  const item = (o: Option<V>) => <ComboboxItem key={String(o.value)} value={o} disabled={o.disabled}><OptionLabel option={o} /></ComboboxItem>
  return (
    <Combobox<Option<V>>
      open={open}
      onOpenChange={setOpen}
      items={groups ?? options}
      value={selected}
      onValueChange={next => { if (next) { onValueChange(next.value); setOpen(false) } }}
      itemToStringLabel={o => o.description ? `${o.label} ${o.description}` : o.label}
      isItemEqualToValue={(a, b) => a.value === b.value}
      autoHighlight
      disabled={disabled}
      modal={false}
    >
      <ComboboxTrigger id={id} data-size={size} className={cn(selectTriggerClassName, className)} {...aria}>
        <ComboboxValue>{(current: Option<V> | null) => <span data-slot="select-value" className="flex min-w-0 flex-1 items-center gap-1.5 text-left">{current ? <OptionLabel option={current} /> : null}</span>}</ComboboxValue>
      </ComboboxTrigger>
      <ComboboxContent onClick={e => e.stopPropagation()} className={cn("min-w-64 text-[13px]", contentClassName)}>
        <ComboboxInput showTrigger={false} placeholder={placeholder} aria-label={placeholder} />
        <ComboboxEmpty>{empty}</ComboboxEmpty>
        <ComboboxList>
          {groups
            ? (g: { value: string; items: Option<V>[] }) => <ComboboxGroup key={g.value} items={g.items}><ComboboxLabel>{g.value}</ComboboxLabel><ComboboxCollection>{item}</ComboboxCollection></ComboboxGroup>
            : item}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  )
}

/** A colour chip for options (faction accents, team colours). */
export function Swatch({ color, className }: { color: string; className?: string }) {
  return <span aria-hidden="true" className={cn("inline-block size-2.5 shrink-0 rounded-[2px] ring-1 ring-black/40", className)} style={{ background: color }} />
}

/** Select-style markup using the shared accessible pickers. */
export function GameSelect({ children, value, defaultValue, onChange, id, disabled, className, "aria-label": label }: {
  children: React.ReactNode; value?: string | number; defaultValue?: string | number;
  onChange?: (event: { target: { value: string } }) => void;
  id?: string; disabled?: boolean; className?: string; "aria-label"?: string;
}) {
  const options = React.Children.toArray(children).filter(React.isValidElement).map(child => {
    const props = (child as React.ReactElement<{ value: string | number; children: React.ReactNode; disabled?: boolean }>).props;
    return { value: String(props.value), label: React.Children.toArray(props.children).join(""), disabled: props.disabled };
  });
  const [current, setCurrent] = React.useState(String(defaultValue ?? options[0]?.value ?? ""));
  const Picker = options.length > 8 ? SearchSelect : OptionSelect;
  return <Picker id={id} aria-label={label} disabled={disabled} className={cn("game-picker", className?.split(/\s+/).filter(c => !["block", "bg-black", "hud-inset", "p-1", "p-2", "ml-2"].includes(c)).join(" "))} value={String(value ?? current)} options={options}
    onValueChange={next => { setCurrent(next); onChange?.({ target: { value: next } }); }} />;
}
