'use client';

/**
 * ConversationTags
 *
 * Inline tag editor for conversations. Displays tags as badges
 * with an add/remove interface. Patches tags via the conversation API.
 */

import { useState } from 'react';
import { Plus, X } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { apiClient } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';

export interface ConversationTagsProps {
  conversationId: string;
  initialTags: string[];
}

export function ConversationTags({ conversationId, initialTags }: ConversationTagsProps) {
  const [tags, setTags] = useState<string[]>(initialTags);
  const [adding, setAdding] = useState(false);
  const [newTag, setNewTag] = useState('');
  const [saving, setSaving] = useState(false);

  const saveTags = async (updatedTags: string[]) => {
    setSaving(true);
    try {
      await apiClient.patch(API.ADMIN.ORCHESTRATION.conversationById(conversationId), {
        body: { tags: updatedTags },
      });
      setTags(updatedTags);
    } finally {
      setSaving(false);
    }
  };

  const handleAdd = () => {
    const tag = newTag.trim();
    if (!tag || tags.includes(tag)) return;
    void saveTags([...tags, tag]);
    setNewTag('');
    setAdding(false);
  };

  const handleRemove = (tag: string) => {
    void saveTags(tags.filter((t) => t !== tag));
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {tags.map((tag) => (
        <Badge key={tag} variant="secondary" className="gap-1 pr-1">
          {tag}
          <button
            type="button"
            onClick={() => handleRemove(tag)}
            disabled={saving}
            className="hover:text-destructive rounded-sm"
            aria-label={`Remove tag ${tag}`}
          >
            <X className="h-3 w-3" />
          </button>
        </Badge>
      ))}
      {adding ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleAdd();
          }}
          className="flex items-center gap-1"
        >
          <Input
            value={newTag}
            onChange={(e) => setNewTag(e.target.value)}
            placeholder="Tag name"
            className="h-7 w-32 text-xs"
            disabled={saving}
          />
          <Button type="submit" variant="ghost" size="icon" className="h-7 w-7" disabled={saving}>
            <Plus className="h-3 w-3" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => {
              setAdding(false);
              setNewTag('');
            }}
          >
            <X className="h-3 w-3" />
          </Button>
        </form>
      ) : (
        <Button
          variant="outline"
          size="sm"
          className="h-6 text-xs"
          onClick={() => setAdding(true)}
          disabled={saving}
        >
          <Plus className="mr-1 h-3 w-3" /> Add tag
        </Button>
      )}
    </div>
  );
}
