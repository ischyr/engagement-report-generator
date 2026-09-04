import mongoose from 'mongoose';

const clientSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, trim: true, lowercase: true },
    firstname: { type: String, trim: true, default: '' },
    lastname: { type: String, trim: true, default: '' },
    phone: { type: String, trim: true, default: '' },
    cell: { type: String, trim: true, default: '' },
    title: { type: String, trim: true, default: '' },
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', default: null },

    /** See Company.createdBy — a contact with no company is visible only to them. */
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

clientSchema.virtual('fullname').get(function fullname() {
  return [this.firstname, this.lastname].filter(Boolean).join(' ');
});
clientSchema.set('toJSON', { virtuals: true });
clientSchema.set('toObject', { virtuals: true });

export const Client = mongoose.model('Client', clientSchema);
export default Client;
