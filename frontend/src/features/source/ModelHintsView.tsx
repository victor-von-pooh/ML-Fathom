import { useId } from 'react'

import type { ModelHints } from '../../api/types'

/**
 * 書き出したデータセットに合わせてモデルを組むときの数
 *
 * ML-CreateArchitecture でモデルを組むとき, 入力の形, 語彙の大きさ, 出力の
 * 幅をデータセットに合わせる必要がある (自動ではつながないので, 数を出す)
 */
export function ModelHintsView({ hints }: { hints: ModelHints }) {
  const id = useId()
  const rows: [string, string, string][] = [
    [
      '入力の形',
      `[バッチ, ${hints.input_shape.join(', ')}]`,
      hints.input_dtype === 'int64' ? 'int64 (語の番号)' : 'float32',
    ],
  ]
  if (hints.vocabulary !== undefined) {
    rows.push([
      '語彙の大きさ',
      String(hints.vocabulary),
      'nn.Embedding の num_embeddings. 0 は埋め草, 1 は語彙に無い語. [CLS] などの印を足す場合はその数も足す',
    ])
  }
  if (hints.outputs !== null) {
    rows.push([
      '出力の幅',
      String(hints.outputs),
      hints.outputs === 1
        ? '最後の nn.Linear の out_features (値を 1 つ)'
        : '最後の nn.Linear の out_features (クラスの数)',
    ])
  }
  return (
    <div className="rounded-lg border border-line p-2">
      <p id={id} className="text-xs font-semibold text-ink-2">
        モデルを組むときの数 (ML-CreateArchitecture の部品の引数に)
      </p>
      <table aria-labelledby={id} className="mt-1 w-full text-xs">
        <thead className="sr-only">
          <tr>
            <th scope="col">項目</th>
            <th scope="col">値</th>
            <th scope="col">使う場所</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([name, value, note]) => (
            <tr key={name} className="border-t border-line first:border-t-0">
              <th
                scope="row"
                className="py-1 pr-2 text-left font-normal whitespace-nowrap text-ink-3"
              >
                {name}
              </th>
              <td className="pr-2 font-mono whitespace-nowrap">{value}</td>
              <td className="text-ink-3">{note}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
