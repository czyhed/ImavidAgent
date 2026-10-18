import { useEffect, useRef, useState } from 'react';

// 输入法友好的受控文本框：组字（拼音）期间只更新本地显示，组字结束或失焦后才提交。
// 获得焦点时不接受外部值覆盖，避免自动保存 / 轮询把正在编辑的内容写回。
export default function DraftText({ value, onCommit, multiline = false, ...props }) {
 const external = value ?? '';
 const [local, setLocal] = useState(external);
 const composing = useRef(false), focused = useRef(false), last = useRef(external);
 useEffect(() => {
  if (!focused.current && !composing.current) { setLocal(external); last.current = external; }
 }, [external]);
 const commit = next => { if (next !== last.current) { last.current = next; onCommit(next); } };
 const handlers = {
  value: local,
  onChange: event => { setLocal(event.target.value); if (!composing.current && !event.nativeEvent?.isComposing) commit(event.target.value); },
  onCompositionStart: () => { composing.current = true; },
  onCompositionEnd: event => { composing.current = false; setLocal(event.currentTarget.value); commit(event.currentTarget.value); },
  onFocus: event => { focused.current = true; props.onFocus?.(event); },
  onBlur: event => { focused.current = false; composing.current = false; commit(event.currentTarget.value); props.onBlur?.(event); },
 };
 return multiline ? <textarea {...props} {...handlers} /> : <input {...props} {...handlers} />;
}
