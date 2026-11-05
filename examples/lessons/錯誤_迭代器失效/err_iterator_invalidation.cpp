// 錯誤教案 #7：迭代器失效（push_back 後仍使用舊的迭代器）
#include <iostream>
#include <vector>

int main() {                             //@ @tts [next] 程式開始
  std::vector<int> v = {1, 2, 3};        //@ @tts [next] 建立 vector v，裡面有 1、2、3，容量剛好也是 3，已經滿了
  auto it = v.begin();                   //@ @tts [next] it 記下第一個元素的位置
  v.push_back(4);                        //@ @bug push_back 放不下時，vector 會另外配一塊更大的記憶體、把元素搬過去，並釋放舊的那一塊。it 仍然指著舊的位置 @tts [next] 加入 4。vector 放不下了，搬到新的位置
  std::cout << "*it = " << *it << "（應為 1）" << std::endl;  //@ @tts [next] 透過 it 讀取。它還指著舊位置，讀到的不是 1
  return 0;                              //@ @tts [next] 回傳 0，main 即將結束
}  //@ @tts [continue] 教案播放完畢
