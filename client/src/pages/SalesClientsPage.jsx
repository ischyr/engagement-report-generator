import { useEffect, useState } from 'react';
import { Building2, Mail, Pencil, Phone, Plus, Trash2, UserPlus } from 'lucide-react';

import { api } from '../lib/api.js';
import { useToast } from '../context/ToastContext.jsx';
import { useResource } from '../hooks/useResource.js';

import { Card, CardBody, CardHeader } from '../components/ui/Card.jsx';
import { PageHeader } from '../components/ui/Misc.jsx';
import { Button } from '../components/ui/Button.jsx';
import { Badge } from '../components/ui/Badge.jsx';
import { Modal, ConfirmDialog } from '../components/ui/Modal.jsx';
import { Input, Select, Toggle } from '../components/ui/Field.jsx';
import { EmptyState, ErrorState, SkeletonRows } from '../components/ui/Feedback.jsx';

function ClientModal({ open, client, onClose, onSaved }) {
  const toast = useToast();
  const isEdit = Boolean(client?.id);
  const [form, setForm] = useState({});
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState({});

  useEffect(() => {
    if (!open) return;
    setForm({
      name: client?.name ?? '',
      shortName: client?.shortName ?? '',
      address: client?.address ?? '',
      website: client?.website ?? '',
      /* Flattened for the form and reassembled on save: nested state in a form is a bug factory. */
      dayRate: client?.billing?.dayRate ?? '',
      vat: client?.billing?.vat ?? '',
      poRequired: Boolean(client?.billing?.poRequired),
      invoiceEmail: client?.billing?.invoiceEmail ?? '',
      invoiceAddress: client?.billing?.invoiceAddress ?? '',
      paymentTermsDays: client?.billing?.paymentTermsDays ?? '',
    });
    setErrors({});
  }, [open, client]);

  const save = async () => {
    if (!form.name?.trim()) return setErrors({ name: 'Required' });
    setSaving(true);
    /*
     * An empty box means "no rate of their own", not zero — the server reads null as "use the rate
     * card", and a 0 here would quote the client free work.
     */
    const numberOrNull = (value) => (String(value).trim() === '' ? null : Number(value));
    const payload = {
      name: form.name,
      shortName: form.shortName,
      address: form.address,
      website: form.website,
      billing: {
        dayRate: numberOrNull(form.dayRate),
        vat: form.vat ?? '',
        poRequired: Boolean(form.poRequired),
        invoiceEmail: form.invoiceEmail ?? '',
        invoiceAddress: form.invoiceAddress ?? '',
        paymentTermsDays: numberOrNull(form.paymentTermsDays),
      },
    };
    try {
      if (isEdit) await api.put(`/sales/clients/${client.id}`, payload);
      else await api.post('/sales/clients', payload);
      toast.success(isEdit ? 'Saved' : `${form.name} added`);
      onSaved?.();
      onClose();
    } catch (error) {
      toast.fromError(error);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isEdit ? `Edit ${client.name}` : 'New client'}
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" loading={saving} onClick={save}>
            {isEdit ? 'Save' : 'Add'}
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Input
          label="Name"
          required
          autoFocus
          wrapperClassName="sm:col-span-2"
          hint="As it should appear on a contract."
          value={form.name ?? ''}
          onChange={(event) => setForm({ ...form, name: event.target.value })}
          error={errors.name}
        />
        <Input
          label="Short name"
          placeholder="Northwind"
          value={form.shortName ?? ''}
          onChange={(event) => setForm({ ...form, shortName: event.target.value })}
        />
        <Input
          label="Website"
          value={form.website ?? ''}
          onChange={(event) => setForm({ ...form, website: event.target.value })}
        />
        <Input
          label="Registered address"
          wrapperClassName="sm:col-span-2"
          hint="Goes on the NDA and the permission to attack."
          value={form.address ?? ''}
          onChange={(event) => setForm({ ...form, address: event.target.value })}
        />

        {/*
          What they pay, and where the invoice goes. Here rather than on every proposal because a
          rate agreed two years ago should not be retyped onto each one.
        */}
        <div className="sm:col-span-2 border-t border-line-soft pt-4">
          <p className="text-xs font-medium text-fg-muted">
            Money{' '}
            <span className="font-normal text-fg-subtle">
              — all optional; the rate card covers whatever is left blank
            </span>
          </p>
        </div>
        <Input
          label="Their day rate"
          type="number"
          min="0"
          step="10"
          placeholder="The standard rate"
          hint="What this client pays, if they negotiated something."
          value={form.dayRate ?? ''}
          onChange={(event) => setForm({ ...form, dayRate: event.target.value })}
        />
        <Input
          label="Days to pay"
          type="number"
          min="0"
          max="365"
          placeholder="Our terms"
          value={form.paymentTermsDays ?? ''}
          onChange={(event) => setForm({ ...form, paymentTermsDays: event.target.value })}
        />
        <Input
          label="Their VAT number"
          hint="For the invoice, and for a reverse-charge clause on the offer."
          value={form.vat ?? ''}
          onChange={(event) => setForm({ ...form, vat: event.target.value })}
        />
        <Input
          label="Where invoices go"
          type="email"
          placeholder="accounts@client.example"
          value={form.invoiceEmail ?? ''}
          onChange={(event) => setForm({ ...form, invoiceEmail: event.target.value })}
        />
        <Input
          label="Invoicing address"
          wrapperClassName="sm:col-span-2"
          placeholder="Only if it differs from the registered address"
          value={form.invoiceAddress ?? ''}
          onChange={(event) => setForm({ ...form, invoiceAddress: event.target.value })}
        />
        {/* Wrapped rather than given a class: Toggle takes no wrapper of its own. */}
        <div className="sm:col-span-2">
          <Toggle
            checked={Boolean(form.poRequired)}
            onChange={(checked) => setForm({ ...form, poRequired: checked })}
            label="They will not pay an invoice without a purchase order"
            hint="The commonest reason an invoice comes back. Flagged on the proposal and on the invoicing list months before it matters."
          />
        </div>
      </div>
    </Modal>
  );
}

function ContactModal({ open, contact, clients, defaultClient, onClose, onSaved }) {
  const toast = useToast();
  const isEdit = Boolean(contact?.id);
  const [form, setForm] = useState({});
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState({});

  useEffect(() => {
    if (!open) return;
    setForm({
      email: contact?.email ?? '',
      firstname: contact?.firstname ?? '',
      lastname: contact?.lastname ?? '',
      title: contact?.title ?? '',
      phone: contact?.phone ?? '',
      cell: contact?.cell ?? '',
      company: contact?.company ?? defaultClient ?? '',
    });
    setErrors({});
  }, [open, contact, defaultClient]);

  const save = async () => {
    if (!form.email?.trim()) return setErrors({ email: 'Required' });
    setSaving(true);
    try {
      const payload = { ...form, company: form.company || null };
      if (isEdit) await api.put(`/sales/contacts/${contact.id}`, payload);
      else await api.post('/sales/contacts', payload);
      toast.success(isEdit ? 'Saved' : 'Contact added');
      onSaved?.();
      onClose();
    } catch (error) {
      toast.fromError(error);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isEdit ? `Edit ${contact.email}` : 'New contact'}
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" loading={saving} onClick={save}>
            {isEdit ? 'Save' : 'Add'}
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Input
          label="Email"
          type="email"
          required
          autoFocus
          wrapperClassName="sm:col-span-2"
          value={form.email ?? ''}
          onChange={(event) => setForm({ ...form, email: event.target.value })}
          error={errors.email}
        />
        <Input
          label="First name"
          value={form.firstname ?? ''}
          onChange={(event) => setForm({ ...form, firstname: event.target.value })}
        />
        <Input
          label="Last name"
          value={form.lastname ?? ''}
          onChange={(event) => setForm({ ...form, lastname: event.target.value })}
        />
        <Input
          label="Job title"
          placeholder="CISO"
          hint="Printed under their signature."
          value={form.title ?? ''}
          onChange={(event) => setForm({ ...form, title: event.target.value })}
        />
        <Select
          label="Works at"
          value={form.company ?? ''}
          onChange={(event) => setForm({ ...form, company: event.target.value })}
          options={[
            { value: '', label: 'Not attached to a client yet' },
            ...(clients ?? []).map((c) => ({ value: c.id, label: c.name })),
          ]}
        />
        <Input
          label="Phone"
          value={form.phone ?? ''}
          onChange={(event) => setForm({ ...form, phone: event.target.value })}
        />
        <Input
          label="Mobile"
          value={form.cell ?? ''}
          onChange={(event) => setForm({ ...form, cell: event.target.value })}
        />
      </div>
    </Modal>
  );
}

/**
 * "1 proposal is" / "2 contacts are" — the verb agrees with the count, not with the noun.
 *
 * Written out because the obvious version reads "1 contact still refer to them", which is the
 * kind of thing nobody notices until it is on screen in front of a customer.
 */
function attachedTo(client) {
  if (!client) return '';
  const parts = [];
  if (client.proposals) parts.push([client.proposals, 'proposal']);
  if (client.contacts?.length) parts.push([client.contacts.length, 'contact']);
  if (!parts.length) return '';

  const total = parts.reduce((sum, [count]) => sum + count, 0);
  const words = parts.map(([count, noun]) => `${count} ${noun}${count === 1 ? '' : 's'}`);
  const list = words.length > 1 ? `${words.slice(0, -1).join(', ')} and ${words.at(-1)}` : words[0];
  return `${list} ${total === 1 ? 'is' : 'are'}`;
}

/**
 * The client book: who we sell to, and who to address the paperwork to.
 *
 * Clients and contacts on one page rather than two, because that is how the question arrives —
 * "add Northwind, and Dana who asked for the test" is one job, not two.
 */
export default function SalesClientsPage() {
  const toast = useToast();
  const { data, error, loading, reload } = useResource('/sales/clients', { initial: null });

  const [clientModal, setClientModal] = useState(null);
  const [contactModal, setContactModal] = useState(null);
  const [pendingDelete, setPendingDelete] = useState(null);
  const [pendingClientDelete, setPendingClientDelete] = useState(null);
  const [deleting, setDeleting] = useState(false);

  const clients = data?.clients ?? [];

  const removeContact = async () => {
    setDeleting(true);
    try {
      await api.del(`/sales/contacts/${pendingDelete.id}`);
      toast.success('Contact removed');
      setPendingDelete(null);
      reload({ quiet: true });
    } catch (err) {
      // The refusal names what is still pointing at them, which is the useful part.
      toast.fromError(err);
    } finally {
      setDeleting(false);
    }
  };

  const removeClient = async () => {
    setDeleting(true);
    try {
      await api.del(`/sales/clients/${pendingClientDelete.id}`);
      toast.success(`${pendingClientDelete.name} removed`);
      setPendingClientDelete(null);
      reload({ quiet: true });
    } catch (err) {
      toast.fromError(err);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Clients"
        description="Who we sell to, and the people the paperwork is addressed to. A client needs a registered address before an NDA will read properly."
        actions={
          <>
            <Button variant="secondary" icon={UserPlus} onClick={() => setContactModal({})}>
              New contact
            </Button>
            <Button variant="primary" icon={Plus} onClick={() => setClientModal({})}>
              New client
            </Button>
          </>
        }
      />

      {loading ? (
        <Card>
          <SkeletonRows rows={4} columns={3} />
        </Card>
      ) : error ? (
        <Card>
          <ErrorState error={error} onRetry={reload} />
        </Card>
      ) : clients.length === 0 ? (
        <Card>
          <EmptyState
            icon={Building2}
            title="No clients yet"
            description="Add the first one, then the people who asked for the work."
            actionLabel="New client"
            onAction={() => setClientModal({})}
          />
        </Card>
      ) : (
        <div className="grid gap-5 lg:grid-cols-2">
          {clients.map((client) => (
            <Card key={client.id}>
              <CardHeader
                icon={Building2}
                title={client.name}
                description={[client.address, client.website].filter(Boolean).join(' · ') || 'No address recorded'}
                actions={
                  <div className="flex items-center gap-1">
                    {client.proposals ? (
                      <Badge tone="info">
                        {client.proposals} proposal{client.proposals === 1 ? '' : 's'}
                      </Badge>
                    ) : null}
                    {!client.address ? <Badge tone="warning">no address</Badge> : null}
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      icon={Pencil}
                      title="Edit client"
                      onClick={() => setClientModal(client)}
                    />
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      icon={UserPlus}
                      title="Add a contact here"
                      onClick={() => setContactModal({ defaultClient: client.id })}
                    />
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      icon={Trash2}
                      title="Delete client"
                      className="hover:text-crit"
                      onClick={() => setPendingClientDelete(client)}
                    />
                  </div>
                }
              />
              <CardBody className="flex flex-col gap-2">
                {client.contacts.length === 0 ? (
                  <p className="text-sm text-fg-subtle">No contacts yet.</p>
                ) : (
                  client.contacts.map((contact) => (
                    <div
                      key={contact.id}
                      className="flex flex-wrap items-center gap-3 rounded-lg border border-line-soft bg-canvas/40 px-3 py-2"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-fg">
                          {contact.fullname}
                          {contact.title ? (
                            <span className="font-normal text-fg-subtle"> · {contact.title}</span>
                          ) : null}
                        </p>
                        <p className="flex flex-wrap items-center gap-x-3 text-xs text-fg-muted">
                          <span className="inline-flex items-center gap-1">
                            <Mail size={11} />
                            {contact.email}
                          </span>
                          {contact.phone || contact.cell ? (
                            <span className="inline-flex items-center gap-1">
                              <Phone size={11} />
                              {contact.phone || contact.cell}
                            </span>
                          ) : null}
                        </p>
                      </div>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        icon={Pencil}
                        title="Edit contact"
                        onClick={() => setContactModal(contact)}
                      />
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        icon={Trash2}
                        title="Remove contact"
                        className="hover:text-crit"
                        onClick={() => setPendingDelete(contact)}
                      />
                    </div>
                  ))
                )}
              </CardBody>
            </Card>
          ))}
        </div>
      )}

      {/* People recorded before their company was, so they do not vanish. */}
      {(data?.unattached ?? []).length ? (
        <Card>
          <CardHeader
            title="Contacts with no client"
            description="Recorded before their company was. Open one and attach it."
          />
          <CardBody className="flex flex-wrap gap-2">
            {data.unattached.map((contact) => (
              <Button key={contact.id} size="sm" variant="secondary" onClick={() => setContactModal(contact)}>
                {contact.fullname}
              </Button>
            ))}
          </CardBody>
        </Card>
      ) : null}

      <ClientModal
        open={Boolean(clientModal)}
        client={clientModal?.id ? clientModal : null}
        onClose={() => setClientModal(null)}
        onSaved={() => reload({ quiet: true })}
      />
      <ContactModal
        open={Boolean(contactModal)}
        contact={contactModal?.id ? contactModal : null}
        defaultClient={contactModal?.defaultClient}
        clients={clients}
        onClose={() => setContactModal(null)}
        onSaved={() => reload({ quiet: true })}
      />
      <ConfirmDialog
        open={Boolean(pendingDelete)}
        onClose={() => setPendingDelete(null)}
        onConfirm={removeContact}
        loading={deleting}
        title="Remove this contact?"
        confirmLabel="Remove"
        message={`${pendingDelete?.fullname ?? 'They'} come off the client book. If an engagement or a proposal still names them the app will refuse and say which, rather than leave a contract naming somebody it can no longer identify. A report already delivered to them keeps its own record of that and is not affected.`}
      />

      <ConfirmDialog
        open={Boolean(pendingClientDelete)}
        onClose={() => setPendingClientDelete(null)}
        onConfirm={removeClient}
        loading={deleting}
        title={`Delete ${pendingClientDelete?.name ?? 'this client'}?`}
        confirmLabel="Delete"
        /*
          Says what is attached rather than predicting the outcome. The server does the deciding —
          it knows about engagements and questionnaires this page never loaded — and its refusal
          names them properly. Guessing here as well would be the same rule written twice, and
          the second copy would be the one that is wrong.
        */
        message={
          attachedTo(pendingClientDelete)
            ? `${attachedTo(pendingClientDelete)} attached to them. Anything still pointing at a client stops it being deleted, so remove those first — an engagement is never deleted along with a client.`
            : 'Nothing on this page refers to them. If an engagement or a questionnaire still does, the app will refuse and say so.'
        }
      />
    </div>
  );
}
