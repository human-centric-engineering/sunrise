'use client';

import * as React from 'react';
import { format, isValid, parse } from 'date-fns';
import { CalendarIcon, X } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

export interface DatePickerProps {
  id?: string;
  /** ISO date string (YYYY-MM-DD) or empty string */
  value: string;
  /** Receives an ISO date string (YYYY-MM-DD) or empty string when cleared */
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  /** Earliest selectable date as ISO YYYY-MM-DD */
  fromDate?: string;
  /** Latest selectable date as ISO YYYY-MM-DD */
  toDate?: string;
  'aria-label'?: string;
  'aria-labelledby'?: string;
}

function parseIso(value: string): Date | undefined {
  if (!value) return undefined;
  const parsed = parse(value, 'yyyy-MM-dd', new Date());
  return isValid(parsed) ? parsed : undefined;
}

function toIso(date: Date): string {
  return format(date, 'yyyy-MM-dd');
}

export function DatePicker({
  id,
  value,
  onChange,
  placeholder = 'dd/mm/yyyy',
  disabled,
  className,
  fromDate,
  toDate,
  ...ariaProps
}: DatePickerProps) {
  const selected = parseIso(value);
  const [open, setOpen] = React.useState(false);

  const handleSelect = (date: Date | undefined) => {
    onChange(date ? toIso(date) : '');
    setOpen(false);
  };

  const handleClear = (e: React.MouseEvent) => {
    e.stopPropagation();
    onChange('');
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          disabled={disabled}
          className={cn(
            'h-9 w-full justify-start px-3 font-normal',
            !selected && 'text-muted-foreground',
            className
          )}
          {...ariaProps}
        >
          <CalendarIcon className="mr-2 size-4 shrink-0 opacity-60" aria-hidden />
          <span className="flex-1 text-left">
            {selected ? format(selected, 'dd/MM/yyyy') : placeholder}
          </span>
          {selected && !disabled ? (
            <span
              role="button"
              tabIndex={0}
              aria-label="Clear date"
              onClick={handleClear}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onChange('');
                }
              }}
              className="text-muted-foreground hover:text-foreground -mr-1 ml-1 inline-flex size-5 items-center justify-center rounded-sm"
            >
              <X className="size-3.5" aria-hidden />
            </span>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          mode="single"
          selected={selected}
          onSelect={handleSelect}
          defaultMonth={selected}
          startMonth={parseIso(fromDate ?? '')}
          endMonth={parseIso(toDate ?? '')}
          disabled={(date) => {
            const min = parseIso(fromDate ?? '');
            const max = parseIso(toDate ?? '');
            if (min && date < min) return true;
            if (max && date > max) return true;
            return false;
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
