import { useState, type InputHTMLAttributes } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

function PasswordInput({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  const { t } = useTranslation('common');
  const [visible, setVisible] = useState(false);

  return (
    <div className="relative">
      <Input type={visible ? 'text' : 'password'} className={cn('pr-10', className)} {...props} />
      <Button
        type="button"
        variant="ghost"
        size="icon-compact"
        className="absolute right-0.5 top-1/2 -translate-y-1/2 text-muted-foreground"
        onClick={() => setVisible((value) => !value)}
        aria-label={visible ? t('password.hide') : t('password.show')}
      >
        {visible ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
      </Button>
    </div>
  );
}

export { PasswordInput };
