//
// Copyright 2021 Vulcanize, Inc.
//

import fs from 'fs';
import path from 'path';
import Handlebars from 'handlebars';
import { Writable } from 'stream';

const TEMPLATE_FILE = './templates/export-state-template.handlebars';

/**
 * Writes the export-state file generated from a template to a stream.
 * @param outStream A writable output stream to write the export-state file to.
 */
export function exportState (outStream: Writable, subgraphPath: string): void {
  const templateString = fs.readFileSync(path.resolve(__dirname, TEMPLATE_FILE)).toString();
  const template = Handlebars.compile(templateString);
  const exportState = template({ subgraphPath });
  outStream.write(exportState);
}
