// Snapshot entries inside the drop event. Directory readers return batches of 100.
export function collectWorkspaceDrop(transfer) {
  const entries = [...(transfer.items || [])].filter(item => item.kind === 'file')
    .map(item => ({entry: item.webkitGetAsEntry?.(), file: item.getAsFile()}));
  const fallback = [...transfer.files];
  return (async () => {
    const files = [], directories = [];
    async function visit(entry, parent = '') {
      const path = parent ? `${parent}/${entry.name}` : entry.name;
      if (entry.isFile) {
        const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
        files.push({file, path});
      } else if (entry.isDirectory) {
        directories.push(path);
        const reader = entry.createReader();
        for (;;) {
          const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
          if (!batch.length) break;
          for (const child of batch) await visit(child, path);
        }
      }
    }
    if (entries.length) {
      for (const item of entries) {
        if (item.entry) await visit(item.entry);
        else if (item.file) files.push({file: item.file, path: item.file.name});
      }
    } else {
      for (const file of fallback) files.push({file, path: file.webkitRelativePath || file.name});
    }
    return {files, directories};
  })();
}

export function workspaceSelection(files) {
  return {files: [...files].map(file => ({file, path: file.webkitRelativePath || file.name})), directories: []};
}

export function workspaceUploadBody(selection) {
  const body = new FormData();
  body.append('manifest', JSON.stringify({files: selection.files.map(item => item.path), directories: selection.directories}));
  for (const {file} of selection.files) body.append('files', file, file.name);
  return body;
}
