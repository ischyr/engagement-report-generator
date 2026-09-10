import { useState } from 'react';
import { CheckCircle2, FileText, OctagonAlert } from 'lucide-react';

import { api } from '../../lib/api.js';
import { formatBytes } from '../../lib/utils.js';

import { Card, CardBody, CardHeader } from '../ui/Card.jsx';
import { Button } from '../ui/Button.jsx';
import { Input, Select } from '../ui/Field.jsx';
import { Alert } from '../ui/Alert.jsx';

/**
 * What turns a generated .docx into a PDF, so a report can be looked at without leaving the app.
 *
 * The same shape as the mail server and the assistant, and for the same reasons: off until it is
 * filled in, degrading to exactly the old behaviour when it is not, and with a test button that
 * reports the converter's own words rather than a shrug. Nothing here is installed by the app —
 * this points at a program that is either on the machine or is not.
 *
 * The test converts one of the shipped templates rather than asking the program for its version. A
 * version string proves a binary exists; it says nothing about whether it can produce a PDF as the
 * account the server runs as, which is exactly where this fails in practice.
 */

const NOTES = {
  none: 'Reports download as a .docx, as they always have. Open one in Word to save a PDF.',
  libreoffice:
    'Cross-platform, and the one for a container — add LibreOffice to the image. Leave the command as “soffice” unless it is somewhere unusual.',
  word: 'Windows only, and Word must be installed for the account the server runs as. It is the program the templates are written for, so its layout is the authoritative one.',
};

export default function PdfCard({ value, onChange }) {
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState(null);

  const converter = value?.converter ?? 'none';
  const set = (patch) => {
    setResult(null);
    onChange({ ...value, ...patch });
  };

  const test = async () => {
    setTesting(true);
    setResult(null);
    try {
      /* The unsaved form, so a converter can be proved before it is committed. */
      const answer = await api.post('/settings/pdf/test', {
        converter,
        command: value?.command ?? '',
        timeoutSeconds: Number(value?.timeoutSeconds) || 120,
      });
      setResult(answer);
    } catch (error) {
      setResult({ ok: false, error: error.message });
    } finally {
      setTesting(false);
    }
  };

  return (
    <Card>
      <CardHeader
        icon={FileText}
        title="Rendering a PDF"
        description="Lets a report be looked at in the app, on the Render button beside Generate. It converts the document that would be sent, so what is on screen is that file and not an approximation."
      />
      <CardBody className="flex flex-col gap-4">
        <Select
          label="Converter"
          value={converter}
          onChange={(event) => set({ converter: event.target.value })}
          options={[
            { value: 'none', label: 'None — download the .docx' },
            { value: 'libreoffice', label: 'LibreOffice' },
            { value: 'word', label: 'Microsoft Word (Windows)' },
          ]}
          hint={NOTES[converter]}
        />

        {converter !== 'none' ? (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <Input
                label="Command"
                value={value?.command ?? ''}
                onChange={(event) => set({ command: event.target.value })}
                placeholder={converter === 'word' ? 'powershell' : 'soffice'}
                hint="Empty uses the default, which is right when it is on the PATH."
                spellCheck={false}
              />
              <Input
                label="Timeout"
                type="number"
                min={10}
                max={600}
                value={value?.timeoutSeconds ?? 120}
                onChange={(event) => set({ timeoutSeconds: Number(event.target.value) })}
                hint="Seconds. A hundred-page report with forty screenshots is not a fast conversion."
              />
            </div>

            {/* Wrapping, and the sentence is the flexible half — see the note in `Button`. */}
            <div className="flex flex-wrap items-center gap-3">
              <Button variant="secondary" size="sm" loading={testing} onClick={test}>
                Convert a test document
              </Button>
              <span className="min-w-0 flex-1 text-[0.6875rem] leading-relaxed text-fg-subtle">
                Converts the default template, which is the shape a real report has.
              </span>
            </div>

            {result ? (
              result.ok ? (
                <Alert tone="success" icon={CheckCircle2} title="It works">
                  A {formatBytes(result.bytes)} PDF came back in {(result.ms / 1000).toFixed(1)}s.
                </Alert>
              ) : (
                <Alert tone="warning" icon={OctagonAlert} title="It did not work">
                  {result.error}
                </Alert>
              )
            ) : null}
          </>
        ) : null}
      </CardBody>
    </Card>
  );
}
