import fs from 'node:fs'
import path from 'node:path'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import matter from 'gray-matter'
import { MDXRemote } from 'next-mdx-remote/rsc'
import { routing } from 'wechatbot-website/src/i18n/routing'
import { EditorialPage } from 'wechatbot-website/src/components/markdown'
import { mdxComponents } from 'wechatbot-website/src/components/mdx-components'

interface TocItem {
  label: string
  href: string
}

interface ContentFrontmatter {
  title: string
  description: string
  toc: TocItem[]
}

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }))
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>
}): Promise<Metadata> {
  const { locale } = await params

  if (!routing.locales.includes(locale as (typeof routing.locales)[number])) {
    return {}
  }

  const t = await getTranslations({ locale, namespace: 'metadata' })

  return {
    title: t('title'),
    description: t('description'),
    openGraph: {
      title: t('title'),
      description: t('description'),
      type: 'website',
    },
    twitter: {
      card: 'summary_large_image',
      title: t('title'),
      description: t('description'),
    },
  }
}

function loadContent(locale: string): { content: string; data: ContentFrontmatter } | null {
  const filePath = path.join(process.cwd(), 'content', locale, 'index.mdx')
  if (!fs.existsSync(filePath)) return null
  const raw = fs.readFileSync(filePath, 'utf-8')
  const { content, data } = matter(raw)
  return { content, data: data as ContentFrontmatter }
}

export default async function Page({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params

  if (!routing.locales.includes(locale as (typeof routing.locales)[number])) {
    notFound()
  }

  const result = loadContent(locale)
  if (!result) notFound()

  const { content, data } = result

  return (
    <EditorialPage toc={data.toc} logo='wechatbot' locale={locale}>
      <MDXRemote source={content} components={mdxComponents} options={{ blockJS: false }} />
    </EditorialPage>
  )
}
