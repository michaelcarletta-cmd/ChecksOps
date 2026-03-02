import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import {
  ArrowLeft,
  LogIn,
  FileText,
  Upload,
  Bell,
  DollarSign,
  MessageSquare,
  HelpCircle,
  ChevronRight,
} from "lucide-react";

const steps = [
  {
    icon: LogIn,
    title: "1. Log In to Your Portal",
    description:
      "Use the email and temporary password from your invite email. You'll be asked to set a new password on first login.",
    tips: [
      "Check your spam/junk folder if you don't see the invite email",
      "Your login email is the same one on file with your adjuster",
      "Contact your adjuster if you need a new invite sent",
    ],
  },
  {
    icon: FileText,
    title: "2. View Your Claims",
    description:
      "After logging in you'll see all claims associated with your account. Click any claim to view its full details, including status, notes, and uploaded documents.",
    tips: [
      "Each claim shows the current status, insurance company, and loss date",
      "Click a claim row to open the detailed view",
      "Use the search bar to quickly find a specific claim",
    ],
  },
  {
    icon: Bell,
    title: "3. Read Notes & Updates",
    description:
      "Inside each claim, the Notes & Updates tab shows messages from your public adjuster. This is where you'll find important status changes, next steps, and action items.",
    tips: [
      "New updates appear at the top of the list",
      "Notes marked as important will be highlighted",
      "You can reply or add your own notes for your adjuster to see",
    ],
  },
  {
    icon: Upload,
    title: "4. Upload Your Documents",
    description:
      "Use the Files tab inside any claim to upload receipts, photos, contracts, or any other documents your adjuster has requested.",
    tips: [
      "Drag and drop files or click the upload button",
      "Supported formats: PDF, JPG, PNG, and more",
      "Organize files into folders for easy access",
    ],
  },
  {
    icon: DollarSign,
    title: "5. Track Your Settlement",
    description:
      "The Overview tab displays your claim's financial summary — including any checks received, the current settlement amount, and outstanding balances.",
    tips: [
      "Check amounts and dates are updated as payments are processed",
      "Your adjuster will note any deductible or depreciation holdbacks",
      "Contact your adjuster if you have questions about any amounts",
    ],
  },
  {
    icon: MessageSquare,
    title: "6. Communicate with Your Adjuster",
    description:
      "Need to ask a question or provide additional information? Use the Notes section to leave a message. Your adjuster will be notified and can respond directly.",
    tips: [
      "Be specific about what you need — include claim numbers or dates",
      "Attach photos or documents directly to your notes",
      "Your adjuster typically responds within 1 business day",
    ],
  },
];

const faqs = [
  {
    q: "I didn't receive my invite email — what do I do?",
    a: "Check your spam or junk folder. If it's not there, contact your adjuster and ask them to resend the invite.",
  },
  {
    q: "Can I access the portal from my phone?",
    a: "Yes! The portal is fully mobile-friendly. Just open the link in your phone's browser.",
  },
  {
    q: "How do I know when there's a new update on my claim?",
    a: "You'll see new notes and status changes highlighted when you log in. Your adjuster may also send you an email notification for important updates.",
  },
  {
    q: "What file types can I upload?",
    a: "You can upload PDFs, images (JPG, PNG), Word documents, and most common file types. The maximum file size is 20MB per file.",
  },
  {
    q: "Is my information secure?",
    a: "Absolutely. Your data is encrypted, and only you and your assigned adjuster can see your claim details.",
  },
];

const ClientPortalHelp = () => {
  const navigate = useNavigate();
  const { signOut } = useAuth();

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="sticky top-0 z-10 bg-background/95 backdrop-blur border-b border-border px-4 py-3">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <Button variant="ghost" size="sm" onClick={() => navigate("/client-portal")}>
            <ArrowLeft className="h-4 w-4 mr-2" /> Back to My Claims
          </Button>
          <Button variant="outline" size="sm" onClick={signOut}>
            Sign Out
          </Button>
        </div>
      </header>

      <div className="max-w-4xl mx-auto px-4 py-8 space-y-10">
        {/* Hero */}
        <div className="text-center space-y-3">
          <div className="inline-flex items-center justify-center h-14 w-14 rounded-full bg-primary/10 mb-2">
            <HelpCircle className="h-7 w-7 text-primary" />
          </div>
          <h1 className="text-3xl md:text-4xl font-bold text-foreground">
            How to Use Your Client Portal
          </h1>
          <p className="text-muted-foreground max-w-2xl mx-auto text-base md:text-lg">
            Everything you need to view updates, upload documents, track your settlement, and stay in touch with your adjuster — all in one place.
          </p>
        </div>

        {/* Steps */}
        <div className="space-y-5">
          {steps.map((step, i) => (
            <Card key={i} className="overflow-hidden border-border/60">
              <CardContent className="p-5 md:p-6">
                <div className="flex gap-4">
                  <div className="shrink-0 h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center mt-0.5">
                    <step.icon className="h-5 w-5 text-primary" />
                  </div>
                  <div className="space-y-2 min-w-0">
                    <h2 className="text-lg font-semibold text-foreground">{step.title}</h2>
                    <p className="text-muted-foreground text-sm leading-relaxed">
                      {step.description}
                    </p>
                    <ul className="space-y-1.5 pt-1">
                      {step.tips.map((tip, j) => (
                        <li key={j} className="flex items-start gap-2 text-sm text-muted-foreground">
                          <ChevronRight className="h-3.5 w-3.5 mt-0.5 text-primary shrink-0" />
                          <span>{tip}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* FAQs */}
        <div className="space-y-4">
          <h2 className="text-2xl font-bold text-foreground">Frequently Asked Questions</h2>
          <div className="grid gap-3">
            {faqs.map((faq, i) => (
              <Card key={i} className="border-border/60">
                <CardContent className="p-4 md:p-5">
                  <p className="font-medium text-foreground text-sm">{faq.q}</p>
                  <p className="text-muted-foreground text-sm mt-1.5">{faq.a}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>

        {/* CTA */}
        <div className="text-center pb-8">
          <Button onClick={() => navigate("/client-portal")} size="lg">
            Go to My Claims
          </Button>
        </div>
      </div>
    </div>
  );
};

export default ClientPortalHelp;
