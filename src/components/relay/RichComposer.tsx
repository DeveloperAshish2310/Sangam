import { forwardRef, useImperativeHandle, useRef } from "react";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Placeholder } from "@tiptap/extensions";
import { Bold, Code, Italic, Link2, List, ListOrdered, Quote, SquareCode, Strikethrough, Underline } from "lucide-react";
import { CAPS } from "@/lib/formatting";
import type { ChannelId } from "@/lib/relay";

export type ComposerHandle = {
  /** Replace the content with plain text (quick replies, Reply, Forward). */
  setText: (text: string) => void;
  clear: () => void;
  focus: () => void;
  getHtml: () => string;
};

type Props = {
  channel: ChannelId;
  placeholder: string;
  showToolbar: boolean;
  onChange: (plainText: string) => void;
  onSubmit: () => void;
  onPasteFiles?: (files: FileList) => void;
  /** "enter" for chats; "ctrl-enter" where Enter should just start a new line (writing an email). */
  submitOn?: "enter" | "ctrl-enter";
  /** Extra classes for the editable area (e.g. a taller box). */
  className?: string;
};

/**
 * The reply box: a rich text editor that only allows the formatting this channel can show
 * (so pasted or typed formatting never silently disappears on send).
 * Enter sends; Shift+Enter is a new line (inside lists and code blocks, Enter continues them).
 */
export const RichComposer = forwardRef<ComposerHandle, Props>(function RichComposer({ channel, placeholder, showToolbar, onChange, onSubmit, onPasteFiles, submitOn = "enter", className = "max-h-40 min-h-[2.25rem]" }, ref) {
  const caps = CAPS[channel];
  // Survives the editor being rebuilt for another channel, so switching accounts keeps what you wrote.
  const lastHtml = useRef("");
  const editor = useEditor(
    {
      // Rendered only in the browser (the page shell is server-rendered).
      immediatelyRender: false,
      content: lastHtml.current,
      extensions: [
        StarterKit.configure({
          heading: false,
          horizontalRule: false,
          bold: caps.bold ? {} : false,
          italic: caps.italic ? {} : false,
          underline: caps.underline ? {} : false,
          strike: caps.strike ? {} : false,
          code: caps.code ? {} : false,
          codeBlock: caps.codeBlock ? {} : false,
          blockquote: caps.quote ? {} : false,
          bulletList: caps.lists ? {} : false,
          orderedList: caps.lists ? {} : false,
          listItem: caps.lists ? {} : false,
          listKeymap: caps.lists ? {} : false,
          link: caps.link ? { openOnClick: false, autolink: true, defaultProtocol: "https" } : false,
        }),
        Placeholder.configure({ placeholder }),
      ],
      editorProps: {
        attributes: { class: `rich-editor scrollbar-thin overflow-y-auto py-2 text-sm outline-none ${className}`, "aria-label": placeholder },
        handleKeyDown: (view, event) => {
          if (event.key !== "Enter" || event.shiftKey || event.isComposing) return false;
          if (submitOn === "ctrl-enter") {
            if (!event.ctrlKey && !event.metaKey) return false;
            event.preventDefault();
            onSubmit();
            return true;
          }
          const { $from } = view.state.selection;
          // Inside a list or code block, Enter keeps editing there (Ctrl+Enter still sends).
          for (let d = $from.depth; d > 0; d--) {
            const name = $from.node(d).type.name;
            if ((name === "listItem" || name === "codeBlock") && !event.ctrlKey && !event.metaKey) return false;
          }
          event.preventDefault();
          onSubmit();
          return true;
        },
        handlePaste: (_view, event) => {
          const files = event.clipboardData?.files;
          if (files?.length && onPasteFiles) {
            onPasteFiles(files);
            return true;
          }
          return false;
        },
      },
      onUpdate: ({ editor: e }) => {
        lastHtml.current = e.isEmpty ? "" : e.getHTML();
        onChange(e.getText());
      },
    },
    // A different channel allows different formatting, so the editor is rebuilt per conversation channel.
    [channel],
  );

  useImperativeHandle(ref, () => ({
    setText: (text) => {
      editor?.commands.setContent(text ? { type: "doc", content: text.split("\n").map((line) => ({ type: "paragraph", content: line ? [{ type: "text", text: line }] : [] })) } : "");
      editor?.commands.focus("end");
      onChange(text);
    },
    clear: () => {
      editor?.commands.clearContent(true);
      onChange("");
    },
    focus: () => editor?.commands.focus(),
    getHtml: () => editor?.getHTML() ?? "",
  }), [editor, onChange]);

  const active = useEditorState({
    editor,
    selector: ({ editor: e }) =>
      e
        ? {
            bold: e.isActive("bold"), italic: e.isActive("italic"), underline: e.isActive("underline"), strike: e.isActive("strike"),
            code: e.isActive("code"), codeBlock: e.isActive("codeBlock"), quote: e.isActive("blockquote"),
            bullet: e.isActive("bulletList"), ordered: e.isActive("orderedList"), link: e.isActive("link"),
          }
        : null,
  });

  const setLink = () => {
    if (!editor) return;
    if (editor.isActive("link")) return void editor.chain().focus().unsetLink().run();
    const url = window.prompt("Link address (https://…)")?.trim();
    if (!url) return;
    const href = /^(https?:|mailto:)/i.test(url) ? url : `https://${url}`;
    editor.chain().focus().extendMarkRange("link").setLink({ href }).run();
  };

  const buttons = editor
    ? [
        caps.bold && { icon: Bold, label: "Bold (Ctrl+B)", on: active?.bold, run: () => editor.chain().focus().toggleBold().run() },
        caps.italic && { icon: Italic, label: "Italic (Ctrl+I)", on: active?.italic, run: () => editor.chain().focus().toggleItalic().run() },
        caps.underline && { icon: Underline, label: "Underline (Ctrl+U)", on: active?.underline, run: () => editor.chain().focus().toggleUnderline().run() },
        caps.strike && { icon: Strikethrough, label: "Strikethrough (Ctrl+Shift+S)", on: active?.strike, run: () => editor.chain().focus().toggleStrike().run() },
        caps.code && { icon: Code, label: "Inline code (Ctrl+E)", on: active?.code, run: () => editor.chain().focus().toggleCode().run() },
        caps.codeBlock && { icon: SquareCode, label: "Code block", on: active?.codeBlock, run: () => editor.chain().focus().toggleCodeBlock().run() },
        caps.quote && { icon: Quote, label: "Quote", on: active?.quote, run: () => editor.chain().focus().toggleBlockquote().run() },
        caps.lists && { icon: List, label: "Bulleted list", on: active?.bullet, run: () => editor.chain().focus().toggleBulletList().run() },
        caps.lists && { icon: ListOrdered, label: "Numbered list", on: active?.ordered, run: () => editor.chain().focus().toggleOrderedList().run() },
        caps.link && { icon: Link2, label: active?.link ? "Remove link" : "Add link", on: active?.link, run: setLink },
      ].filter((b): b is Exclude<typeof b, false> => !!b)
    : [];

  return (
    <div className="min-w-0 flex-1">
      {showToolbar && buttons.length > 0 && (
        <div className="flex flex-wrap gap-0.5 border-b pb-1">
          {buttons.map((b) => (
            <button key={b.label} type="button" title={b.label} aria-pressed={!!b.on} onMouseDown={(e) => e.preventDefault()} onClick={b.run}
              className={`grid h-7 w-7 place-items-center rounded-md transition-colors ${b.on ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}>
              <b.icon className="h-3.5 w-3.5" />
            </button>
          ))}
        </div>
      )}
      <EditorContent editor={editor} />
    </div>
  );
});
