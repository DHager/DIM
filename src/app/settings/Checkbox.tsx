import * as React from 'react';
import { Settings } from './reducer';
import { t } from 'i18next';
import { AppIcon, helpIcon } from '../shell/icons';

export default function Checkbox({
  label,
  title,
  value,
  helpLink,
  name,
  onChange
}: {
  label: string;
  value: boolean;
  title?: string;
  helpLink?: string;
  name: keyof Settings;
  onChange: React.ChangeEventHandler<HTMLInputElement>;
}) {
  return (
    <div className="setting horizontal">
      <label htmlFor={name} title={title && t(title)}>
        {t(label)}
      </label>

      {helpLink && (
        <a
          className="stylizedAnchor"
          aria-hidden="true"
          href={helpLink}
          target="_blank"
          rel="noopener noreferrer"
        >
          <AppIcon icon={helpIcon} />
        </a>
      )}
      <input type="checkbox" name={name} checked={value} onChange={onChange} />
    </div>
  );
}
