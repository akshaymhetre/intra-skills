// The skill page's dialogs: edit metadata, deprecate (with a reason), delete (type the name to confirm).
import { useEffect, useState } from "react";
import { SUGGESTED_AREAS, TOOLS, type SkillDetail, type ToolId } from "@intra-skills/shared/types";
import { api } from "../../api";
import { plural } from "../../lib/format";
import { Button, Checkbox, ConfirmDialog, Dialog, Field, Id, InlineError, Input, toolLabel, useToast } from "../../components/ui";


const splitList = (v: string) =>
  v
    .split(/[,\s]+/)
    .map((x) => x.trim().toLowerCase())
    .filter((x, i, a) => x && a.indexOf(x) === i);

export function EditMetadataDialog({ open, onClose, skill, onSaved }: { open: boolean; onClose: () => void; skill: SkillDetail; onSaved: (s: SkillDetail) => void }) {
  const toast = useToast();
  const [areas, setAreas] = useState("");
  const [tags, setTags] = useState("");
  const [stacks, setStacks] = useState("");
  const [tools, setTools] = useState<ToolId[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>();
  useEffect(() => {
    if (!open) return;
    setAreas(skill.areas.join(", "));
    setTags(skill.tags.join(", "));
    setStacks(skill.stacks.join(", "));
    setTools(skill.tools);
    setErr(undefined);
  }, [open, skill]);
  const save = async () => {
    setBusy(true);
    setErr(undefined);
    try {
      onSaved(await api.patchSkill(skill.name, { areas: splitList(areas), stacks: splitList(stacks), tags: splitList(tags), tools: TOOLS.filter((t) => tools.includes(t)) }));
      onClose();
      toast({ message: "Saved metadata" });
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={<>Edit <Id>{skill.name}</Id></>}
      description={
        <>
          These keys drive search and filters. The next publish reads them from <span className="font-mono whitespace-nowrap">SKILL.md</span> again, so change them there too.
        </>
      }
      width="max-w-lg"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={save}>
            Save metadata
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Field label="areas" htmlFor="md-areas" hint={<>Comma separated. Common: {SUGGESTED_AREAS.slice(0, 6).join(", ")}.</>}>
          <Input id="md-areas" mono value={areas} onChange={(e) => setAreas(e.target.value)} />
        </Field>
        <Field label="stacks" htmlFor="md-stacks" hint="Comma separated, e.g. terraform, aws. Stack pages group skills by these.">
          <Input id="md-stacks" mono value={stacks} onChange={(e) => setStacks(e.target.value)} />
        </Field>
        <Field label="tags" htmlFor="md-tags" hint="Comma separated, lowercase.">
          <Input id="md-tags" mono value={tags} onChange={(e) => setTags(e.target.value)} />
        </Field>
        <fieldset>
          <legend className="mb-1 text-sm font-medium">tools</legend>
          <div className="flex flex-wrap gap-x-5">
            {TOOLS.map((t) => (
              <Checkbox key={t} checked={tools.includes(t)} onChange={(on) => setTools((c) => (on ? [...c, t] : c.filter((x) => x !== t)))} className="min-h-8">
                {toolLabel(t)}
              </Checkbox>
            ))}
          </div>
          {tools.length === 0 && <p className="mt-1 text-sm text-fg-muted">With no tool declared, the console treats it as working everywhere.</p>}
        </fieldset>
        <InlineError error={err} />
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

export function DeprecateDialog({ open, onClose, skill, onSaved }: { open: boolean; onClose: () => void; skill: SkillDetail; onSaved: (s: SkillDetail) => void }) {
  const toast = useToast();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>();
  const [tried, setTried] = useState(false);
  useEffect(() => {
    if (open) {
      setReason("");
      setErr(undefined);
      setTried(false);
    }
  }, [open]);
  const run = async () => {
    setTried(true);
    if (!reason.trim()) return;
    setBusy(true);
    setErr(undefined);
    try {
      onSaved(await api.patchSkill(skill.name, { deprecated: reason.trim() }));
      onClose();
      toast({
        message: (
          <>
            Deprecated <span className="font-mono whitespace-nowrap">{skill.name}</span>
          </>
        ),
        action: { label: "Undo", onClick: () => void api.patchSkill(skill.name, { deprecated: null }).then(onSaved) },
      });
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
      onConfirm={run}
      title={<>Deprecate <Id>{skill.name}</Id>?</>}
      description="It keeps installing, but everyone sees a warning with your reason, here and in the catalog. Point people to what replaces it."
      confirmLabel="Deprecate skill"
      busy={busy}
      error={err}
    >
      <Field label="Reason" htmlFor="dep-reason" error={tried && !reason.trim() ? "Write a reason before deprecating." : undefined}>
        <textarea
          id="dep-reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={3}
          aria-invalid={tried && !reason.trim()}
          placeholder="e.g. Superseded by react-component-audit 2.0"
          className="w-full rounded-md border border-line-strong bg-surface px-2.5 py-2 text-base text-fg placeholder:text-fg-subtle hover:border-line-control focus-visible:border-focus aria-[invalid=true]:border-danger-text"
        />
      </Field>
    </ConfirmDialog>
  );
}

export function DeleteDialog({ open, onClose, skill, onDeleted }: { open: boolean; onClose: () => void; skill: SkillDetail; onDeleted: () => void }) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>();
  const [tried, setTried] = useState(false);
  useEffect(() => {
    if (open) {
      setTyped("");
      setErr(undefined);
      setTried(false);
    }
  }, [open]);
  const match = typed.trim() === skill.name;
  const run = async () => {
    setTried(true);
    if (!match) return;
    setBusy(true);
    setErr(undefined);
    try {
      await api.deleteSkill(skill.name);
      onClose();
      onDeleted();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
      onConfirm={run}
      title={<>Delete <Id>{skill.name}</Id>?</>}
      description={
        <>
          This removes all {plural(skill.versions.length, "version")} and their files from the registry and cannot be undone. Copies already installed keep working, but{" "}
          <span className="font-mono whitespace-nowrap">intra install {skill.name}</span> and every lockfile that names it will fail.
        </>
      }
      confirmLabel="Delete skill"
      danger
      busy={busy}
      error={err}
    >
      <Field
        label={`Type ${skill.name} to confirm`}
        htmlFor="del-name"
        error={tried && !match ? "The name does not match." : undefined}
      >
        <Input
          id="del-name"
          mono
          autoComplete="off"
          spellCheck={false}
          value={typed}
          aria-invalid={tried && !match}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void run();
            }
          }}
        />
      </Field>
    </ConfirmDialog>
  );
}

